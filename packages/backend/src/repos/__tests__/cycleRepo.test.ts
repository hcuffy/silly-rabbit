import type { Cycle } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { CycleRepo } from "../cycleRepo.js";

function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: randomUUID(),
    name: "Release 3.22",
    kind: "release",
    status: "active",
    isDefault: false,
    runCounter: 0,
    sessionReplayRunCounter: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("CycleRepo (run-cycles-spec.md §3/§6) — mongodb-memory-server, no Docker", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
  });

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  afterEach(async () => {
    await connection.db.collection("cycles").deleteMany({});
  });

  it("round-trips a created cycle", async () => {
    const repo = new CycleRepo(connection.db);
    const cycle = makeCycle();

    await repo.create(cycle);
    const retrieved = await repo.get(cycle.id);

    expect(retrieved).toEqual(cycle);
  });

  it("get returns null for an unknown id", async () => {
    const repo = new CycleRepo(connection.db);
    expect(await repo.get(randomUUID())).toBeNull();
  });

  it("list returns cycles sorted by createdAt ascending, and supports an optional status filter", async () => {
    const repo = new CycleRepo(connection.db);
    const older = makeCycle({ name: "Sprint 1", createdAt: new Date("2026-01-01") });
    const newer = makeCycle({ name: "Sprint 2", createdAt: new Date("2026-02-01") });
    const archived = makeCycle({ name: "Sprint 0", status: "archived", createdAt: new Date("2025-12-01") });
    await repo.create(older);
    await repo.create(newer);
    await repo.create(archived);

    const all = await repo.list();
    expect(all.map((cycle) => cycle.name)).toEqual(["Sprint 0", "Sprint 1", "Sprint 2"]);

    const activeOnly = await repo.list({ status: "active" });
    expect(activeOnly.map((cycle) => cycle.name)).toEqual(["Sprint 1", "Sprint 2"]);
  });

  it("archive flips status and sets archivedAt, and reports true only when a real change happened", async () => {
    const repo = new CycleRepo(connection.db);
    const cycle = makeCycle();
    await repo.create(cycle);

    const firstArchive = await repo.archive(cycle.id);
    expect(firstArchive).toBe(true);
    const archived = await repo.get(cycle.id);
    expect(archived?.status).toBe("archived");
    expect(archived?.archivedAt).toBeInstanceOf(Date);

    const secondArchive = await repo.archive(cycle.id);
    expect(secondArchive).toBe(false);
  });

  it("archive refuses to archive the isDefault cycle — real assertion against the stored document, not " + "just the return value", async () => {
    const repo = new CycleRepo(connection.db);
    const defaultCycle = makeCycle({ isDefault: true, name: "Uncategorized" });
    await repo.create(defaultCycle);

    const result = await repo.archive(defaultCycle.id);

    expect(result).toBe(false);
    expect((await repo.get(defaultCycle.id))?.status).toBe("active");
  });

  it(
    "incrementAndGetRunNumber returns a 1-based sequence, and is independent of " +
      "incrementAndGetSessionReplayRunNumber's own sequence on the same cycle",
    async () => {
      const repo = new CycleRepo(connection.db);
      const cycle = makeCycle();
      await repo.create(cycle);

      expect(await repo.incrementAndGetRunNumber(cycle.id)).toBe(1);
      expect(await repo.incrementAndGetRunNumber(cycle.id)).toBe(2);
      expect(await repo.incrementAndGetSessionReplayRunNumber(cycle.id)).toBe(1);
      expect(await repo.incrementAndGetRunNumber(cycle.id)).toBe(3);
      expect(await repo.incrementAndGetSessionReplayRunNumber(cycle.id)).toBe(2);
    },
  );

  it("incrementAndGetRunNumber/incrementAndGetSessionReplayRunNumber return undefined for an unknown cycleId, " + "not a thrown error", async () => {
    const repo = new CycleRepo(connection.db);
    expect(await repo.incrementAndGetRunNumber(randomUUID())).toBeUndefined();
    expect(await repo.incrementAndGetSessionReplayRunNumber(randomUUID())).toBeUndefined();
  });

  it(
    "N real concurrent incrementAndGetRunNumber calls against the same cycle produce N distinct " +
      "sequential numbers with no duplicates and no gaps — the actual proof the atomic $inc closes the " +
      "race, not just 'looks atomic'",
    async () => {
      const repo = new CycleRepo(connection.db);
      const cycle = makeCycle();
      await repo.create(cycle);

      const CONCURRENT_COUNT = 25;
      const results = await Promise.all(Array.from({ length: CONCURRENT_COUNT }, () => repo.incrementAndGetRunNumber(cycle.id)));

      expect(results.every((value) => value !== undefined)).toBe(true);
      const sorted = [...results].sort((a, b) => (a ?? 0) - (b ?? 0));
      expect(sorted).toEqual(Array.from({ length: CONCURRENT_COUNT }, (_, index) => index + 1));

      const final = await repo.get(cycle.id);
      expect(final?.runCounter).toBe(CONCURRENT_COUNT);
    },
  );

  it(
    "N real concurrent runs racing between incrementAndGetRunNumber and " +
      "incrementAndGetSessionReplayRunNumber on the same cycle don't cross-contaminate each other's sequence",
    async () => {
      const repo = new CycleRepo(connection.db);
      const cycle = makeCycle();
      await repo.create(cycle);

      const HALF_COUNT = 15;
      const [runResults, replayResults] = await Promise.all([
        Promise.all(Array.from({ length: HALF_COUNT }, () => repo.incrementAndGetRunNumber(cycle.id))),
        Promise.all(Array.from({ length: HALF_COUNT }, () => repo.incrementAndGetSessionReplayRunNumber(cycle.id))),
      ]);

      expect([...runResults].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: HALF_COUNT }, (_, index) => index + 1));
      expect([...replayResults].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: HALF_COUNT }, (_, index) => index + 1));
    },
  );

  it(
    "ensureDefaultCycle creates exactly one isDefault cycle, and is a no-op on a second sequential call " + "(the restart-idempotency case)",
    async () => {
      const repo = new CycleRepo(connection.db);

      await repo.ensureDefaultCycle();
      const afterFirst = await connection.db.collection("cycles").find({ isDefault: true }).toArray();
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]?.name).toBe("Uncategorized");
      const firstId = afterFirst[0]?._id;

      await repo.ensureDefaultCycle();
      const afterSecond = await connection.db.collection("cycles").find({ isDefault: true }).toArray();
      expect(afterSecond).toHaveLength(1);
      expect(afterSecond[0]?._id).toBe(firstId);
    },
  );

  it(
    "N real concurrent ensureDefaultCycle calls (the simultaneous dev+mcp first-boot case) still produce " +
      "exactly one isDefault cycle — proves the unique partial index closes the race, not just the " +
      "check-then-insert's happy path",
    async () => {
      const repo = new CycleRepo(connection.db);
      await repo.ensureIndexes();

      await Promise.all(Array.from({ length: 10 }, () => repo.ensureDefaultCycle()));

      const defaults = await connection.db.collection("cycles").find({ isDefault: true }).toArray();
      expect(defaults).toHaveLength(1);
    },
  );

  it("ensureIndexes creates a status index and a unique partial index on isDefault, and is idempotent", async () => {
    const repo = new CycleRepo(connection.db);
    await repo.ensureIndexes();
    await repo.ensureIndexes();

    const indexes = await connection.db.collection("cycles").indexes();
    expect(indexes.some((index) => index.key.status === 1)).toBe(true);
    const defaultIndex = indexes.find((index) => index.key.isDefault === 1);
    expect(defaultIndex?.unique).toBe(true);
    expect(defaultIndex?.partialFilterExpression).toEqual({ isDefault: true });
  });

  it(
    "the unique partial index rejects a second isDefault:true document inserted directly, but allows " + "any number of isDefault:false documents",
    async () => {
      const repo = new CycleRepo(connection.db);
      await repo.ensureIndexes();

      await repo.create(makeCycle({ isDefault: true }));
      await expect(repo.create(makeCycle({ isDefault: true }))).rejects.toThrow();

      await repo.create(makeCycle({ isDefault: false }));
      await repo.create(makeCycle({ isDefault: false }));
      const nonDefaultCount = await connection.db.collection("cycles").countDocuments({ isDefault: false });
      expect(nonDefaultCount).toBe(2);
    },
  );
});
