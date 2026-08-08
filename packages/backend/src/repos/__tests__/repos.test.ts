import type { AppMap, Baseline, Finding, Run } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { AppMapRepo } from "../appMapRepo.js";
import { BaselineRepo } from "../baselineRepo.js";
import { FindingRepo } from "../findingRepo.js";
import { RunRepo } from "../runRepo.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    charter: "test the locations flow",
    targetBaseUrl: "http://mock.local",
    status: "PENDING",
    startedAt: new Date(),
    stepsUsed: 0,
    llmCallsUsed: 0,
    costUsd: 0,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  const now = new Date();
  return {
    id: randomUUID(),
    runId: "run-1",
    screenId: "screen-1",
    type: "CONSOLE_ERROR",
    evidence: { consoleMessages: ["boom"] },
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    screenId: "screen-1",
    fingerprint: "fp-1",
    ariaSnapshotMasked: '- heading "Locations"',
    capturedAt: new Date(),
    runId: "run-1",
    ...overrides,
  };
}

function makeAppMap(overrides: Partial<AppMap> = {}): AppMap {
  return { id: randomUUID(), baseUrl: "http://mock.local", screens: [], ...overrides };
}

describe("Mongo repositories (backend-spec §3/§7) — mongodb-memory-server, no Docker", () => {
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

  describe("RunRepo", () => {
    it("round-trips a created run, validated against RunSchema", async () => {
      const repo = new RunRepo(connection.db);
      const run = makeRun();
      await repo.create(run);
      expect(await repo.get(run.id)).toEqual(run);
    });

    it("updateStatus patches only the given fields and survives a re-read", async () => {
      const repo = new RunRepo(connection.db);
      const run = makeRun();
      await repo.create(run);

      const finishedAt = new Date();
      await repo.updateStatus(run.id, { status: "COMPLETED", finishedAt, stepsUsed: 4 });

      const fetched = await repo.get(run.id);
      expect(fetched?.status).toBe("COMPLETED");
      expect(fetched?.stepsUsed).toBe(4);
      expect(fetched?.finishedAt).toEqual(finishedAt);
      expect(fetched?.charter).toBe(run.charter);
    });

    it("list returns newest-first", async () => {
      const repo = new RunRepo(connection.db);
      const older = makeRun({ startedAt: new Date(Date.now() - 60_000) });
      const newer = makeRun({ startedAt: new Date() });
      await repo.create(older);
      await repo.create(newer);

      const ids = (await repo.list({ limit: 25, offset: 0 })).runs.map((run) => run.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    });

    it("ensureIndexes creates a startedAt index matching list()'s query shape, and is idempotent", async () => {
      const repo = new RunRepo(connection.db);
      await repo.ensureIndexes();
      await repo.ensureIndexes();

      const indexes = await connection.db.collection("runs").indexes();
      expect(indexes.some((index) => index.key.startedAt === -1)).toBe(true);
    });

    it("findIdsByTargetBaseUrl returns only runs for that exact target, and ensureIndexes creates the compound index", async () => {
      const repo = new RunRepo(connection.db);
      const targetA = `http://target-a-${randomUUID()}.local`;
      const targetB = `http://target-b-${randomUUID()}.local`;
      const runA1 = makeRun({ targetBaseUrl: targetA });
      const runA2 = makeRun({ targetBaseUrl: targetA });
      const runB = makeRun({ targetBaseUrl: targetB });
      await Promise.all([repo.create(runA1), repo.create(runA2), repo.create(runB)]);

      const ids = await repo.findIdsByTargetBaseUrl(targetA);
      expect(ids.sort()).toEqual([runA1.id, runA2.id].sort());

      await repo.ensureIndexes();
      await repo.ensureIndexes();
      const indexes = await connection.db.collection("runs").indexes();
      expect(indexes.some((index) => index.key.targetBaseUrl === 1 && index.key.startedAt === -1)).toBe(true);
    });

    it("findIdsByCycleId returns only runs stamped with that cycleId, and list()'s cycleId filter matches", async () => {
      const repo = new RunRepo(connection.db);
      const cycleA = randomUUID();
      const cycleB = randomUUID();
      const runA1 = makeRun({ cycleId: cycleA, cycleRunNumber: 1 });
      const runA2 = makeRun({ cycleId: cycleA, cycleRunNumber: 2 });
      const runB = makeRun({ cycleId: cycleB, cycleRunNumber: 1 });
      const uncycled = makeRun();
      await Promise.all([repo.create(runA1), repo.create(runA2), repo.create(runB), repo.create(uncycled)]);

      const ids = await repo.findIdsByCycleId(cycleA);
      expect(ids.sort()).toEqual([runA1.id, runA2.id].sort());

      const listed = await repo.list({ limit: 25, offset: 0, cycleId: cycleA });
      expect(listed.total).toBe(2);
      expect(listed.runs.map((run) => run.id).sort()).toEqual([runA1.id, runA2.id].sort());
    });

    it(
      "list paginates with limit/offset and reports the true total, using far-future startedAt values so these " +
        "5 runs sort strictly first regardless of what other tests in this shared collection already inserted",
      async () => {
        const repo = new RunRepo(connection.db);
        const totalBefore = (await repo.list({ limit: 1, offset: 0 })).total;

        const farFuture = new Date("2099-01-01T00:00:00.000Z").getTime();
        const runs = Array.from({ length: 5 }, (_, index) => makeRun({ startedAt: new Date(farFuture - index * 1000) }));
        await Promise.all(runs.map((run) => repo.create(run)));

        const firstPage = await repo.list({ limit: 2, offset: 0 });
        expect(firstPage.runs).toHaveLength(2);
        expect(firstPage.total).toBe(totalBefore + 5);
        expect(firstPage.runs[0]?.id).toBe(runs[0]?.id);
        expect(firstPage.runs[1]?.id).toBe(runs[1]?.id);

        const secondPage = await repo.list({ limit: 2, offset: 2 });
        expect(secondPage.runs).toHaveLength(2);
        expect(secondPage.total).toBe(totalBefore + 5);
        expect(secondPage.runs[0]?.id).toBe(runs[2]?.id);

        const thirdPage = await repo.list({ limit: 2, offset: 4 });
        expect(thirdPage.runs[0]?.id).toBe(runs[4]?.id);
      },
    );
  });

  describe("FindingRepo", () => {
    it("round-trips an upserted finding, validated against FindingSchema", async () => {
      const repo = new FindingRepo(connection.db);
      const finding = makeFinding();
      await repo.upsert(finding);
      expect(await repo.get(finding.id)).toEqual(finding);
    });

    it("upsert by dedupKey replaces the prior doc rather than duplicating it", async () => {
      const repo = new FindingRepo(connection.db);
      const finding = makeFinding({ dedupKey: "dedup-shared" });
      await repo.upsert(finding);

      const recurring: Finding = { ...finding, status: "RECURRING", verdict: "KNOWN", updatedAt: new Date() };
      await repo.upsert(recurring);

      const byDedup = await repo.findByDedupKeys(["dedup-shared"]);
      expect(byDedup).toHaveLength(1);
      expect(byDedup[0]?.status).toBe("RECURRING");
    });

    it("findByScreenIds and listByRun scope correctly", async () => {
      const repo = new FindingRepo(connection.db);
      const a = makeFinding({ dedupKey: "a", screenId: "screen-a", runId: "run-x" });
      const b = makeFinding({ dedupKey: "b", screenId: "screen-b", runId: "run-x" });
      await repo.upsert(a);
      await repo.upsert(b);

      expect((await repo.findByScreenIds(["screen-a"])).map((f) => f.dedupKey)).toEqual(["a"]);
      expect(await repo.listByRun("run-x")).toHaveLength(2);
    });

    it("findByRunIds returns findings across multiple runIds, and an empty array short-circuits to []", async () => {
      const repo = new FindingRepo(connection.db);
      const runId1 = `run-${randomUUID()}`;
      const runId2 = `run-${randomUUID()}`;
      const runId3 = `run-${randomUUID()}`;
      const findingInRun1 = makeFinding({ dedupKey: `dedup-${randomUUID()}`, runId: runId1 });
      const findingInRun2 = makeFinding({ dedupKey: `dedup-${randomUUID()}`, runId: runId2 });
      const findingInRun3 = makeFinding({ dedupKey: `dedup-${randomUUID()}`, runId: runId3 });
      await Promise.all([repo.upsert(findingInRun1), repo.upsert(findingInRun2), repo.upsert(findingInRun3)]);

      const found = await repo.findByRunIds([runId1, runId2]);
      expect(found.map((f) => f.dedupKey).sort()).toEqual([findingInRun1.dedupKey, findingInRun2.dedupKey].sort());
      expect(await repo.findByRunIds([])).toEqual([]);
    });

    it("ensureIndexes creates indexes matching every query shape (dedupKey, runId, screenId), and is idempotent", async () => {
      const repo = new FindingRepo(connection.db);
      await repo.ensureIndexes();
      await repo.ensureIndexes();

      const indexes = await connection.db.collection("findings").indexes();
      expect(indexes.some((index) => index.key.dedupKey === 1)).toBe(true);
      expect(indexes.some((index) => index.key.runId === 1)).toBe(true);
      expect(indexes.some((index) => index.key.screenId === 1)).toBe(true);
    });
  });

  describe("BaselineRepo", () => {
    it("round-trips an upserted baseline, keyed by screenId", async () => {
      const repo = new BaselineRepo(connection.db);
      const baseline = makeBaseline({ screenId: "screen-roundtrip" });
      await repo.upsert(baseline);

      const [fetched] = await repo.getByScreenIds([baseline.screenId]);
      expect(fetched).toEqual(baseline);
    });

    it("upsert replaces the existing baseline for a screenId rather than duplicating", async () => {
      const repo = new BaselineRepo(connection.db);
      const baseline = makeBaseline({ screenId: "screen-replace" });
      await repo.upsert(baseline);
      await repo.upsert({ ...baseline, fingerprint: "fp-2" });

      const matches = await repo.getByScreenIds(["screen-replace"]);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.fingerprint).toBe("fp-2");
    });
  });

  describe("AppMapRepo", () => {
    it("round-trips an upserted AppMap", async () => {
      const repo = new AppMapRepo(connection.db);
      const appMap = makeAppMap({
        screens: [{ screenId: "s1", normalizedUrl: "http://mock.local/x", headingAnchor: "X", discoveredAt: new Date() }],
      });
      await repo.upsert(appMap);
      expect(await repo.get()).toEqual(appMap);
    });
  });
});
