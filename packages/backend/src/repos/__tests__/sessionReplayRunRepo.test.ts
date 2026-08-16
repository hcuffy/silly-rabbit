import type { SessionReplayRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { SessionReplayRunRepo } from "../sessionReplayRunRepo.js";

function makeRun(overrides: Partial<SessionReplayRun> = {}): SessionReplayRun {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    replayMode: "live",
    status: "PENDING",
    startedAt: new Date(),
    summary: { stepsExecuted: 0, stepsDrifted: 0, stepsErrored: 0 },
    ...overrides,
  };
}

describe("SessionReplayRunRepo (session-replay-spec §8.2) — mongodb-memory-server, no Docker", () => {
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

  it("round-trips a created run", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    const run = makeRun();
    await repo.create(run);
    expect(await repo.get(run.id)).toEqual(run);
  });

  it("get returns null for an unknown id", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    expect(await repo.get(randomUUID())).toBeNull();
  });

  it("update patches status/summary/completedAt/error without touching immutable fields " + "(id/sessionId/replayMode/startedAt)", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    const run = makeRun();
    await repo.create(run);

    await repo.update(run.id, { status: "RUNNING" });
    let fetched = await repo.get(run.id);
    expect(fetched?.status).toBe("RUNNING");
    expect(fetched?.sessionId).toBe(run.sessionId);
    expect(fetched?.startedAt).toEqual(run.startedAt);

    const completedAt = new Date();
    await repo.update(run.id, { status: "COMPLETED", completedAt, summary: { stepsExecuted: 3, stepsDrifted: 1, stepsErrored: 0 } });
    fetched = await repo.get(run.id);
    expect(fetched?.status).toBe("COMPLETED");
    expect(fetched?.completedAt).toEqual(completedAt);
    expect(fetched?.summary).toEqual({ stepsExecuted: 3, stepsDrifted: 1, stepsErrored: 0 });
  });

  it("update with an error message persists it (FAILED-status path)", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    const run = makeRun();
    await repo.create(run);

    await repo.update(run.id, { status: "FAILED", completedAt: new Date(), error: "browser launch failed" });
    const fetched = await repo.get(run.id);
    expect(fetched?.status).toBe("FAILED");
    expect(fetched?.error).toBe("browser launch failed");
  });

  it(
    "does not reintroduce the undefined-serializes-as-null bug class — an explicit undefined " +
      "completedAt/error on create, and on a patch, is stripped rather than written as a literal null",
    async () => {
      const repo = new SessionReplayRunRepo(connection.db);
      const run = makeRun({ completedAt: undefined, error: undefined });
      await repo.create(run);

      let document = await connection.db.collection<{ _id: string }>("sessionReplayRuns").findOne({ _id: run.id });
      expect(document).not.toHaveProperty("completedAt");
      expect(document).not.toHaveProperty("error");

      await repo.update(run.id, {
        status: "RUNNING",
        summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
        completedAt: undefined,
        error: undefined,
      });

      document = await connection.db.collection<{ _id: string }>("sessionReplayRuns").findOne({ _id: run.id });
      expect(document).not.toHaveProperty("completedAt");
      expect(document).not.toHaveProperty("error");
    },
  );

  it("list paginates most-recent-first and reports total, mirroring RunRepo.list()", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    const older = makeRun({ startedAt: new Date("2020-01-01T00:00:00Z") });
    const newer = makeRun({ startedAt: new Date("2020-01-02T00:00:00Z") });
    await repo.create(older);
    await repo.create(newer);

    const fullList = await repo.list({ limit: 1000, offset: 0 });
    const ids = fullList.sessionReplayRuns.map((run) => run.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(fullList.total).toBeGreaterThanOrEqual(2);

    const onePage = await repo.list({ limit: 1, offset: 0 });
    expect(onePage.sessionReplayRuns).toHaveLength(1);
  });

  it("ensureIndexes creates a sessionId+startedAt compound index, and is idempotent", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    await repo.ensureIndexes();
    await repo.ensureIndexes();

    const indexes = await connection.db.collection("sessionReplayRuns").indexes();
    expect(indexes.some((index) => index.key.sessionId === 1 && index.key.startedAt === -1)).toBe(true);
  });

  it("cancel() flips RUNNING to CANCELLED and returns true; false and unchanged once COMPLETED " + "(delete-cancel-spec.md, phase 1)", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    const running = makeRun({ status: "RUNNING" });
    await repo.create(running);
    expect(await repo.cancel(running.id)).toBe(true);
    const cancelled = await repo.get(running.id);
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.completedAt).toBeInstanceOf(Date);

    const completed = makeRun({ status: "COMPLETED" });
    await repo.create(completed);
    expect(await repo.cancel(completed.id)).toBe(false);
    expect((await repo.get(completed.id))?.status).toBe("COMPLETED");
  });

  it("delete() removes the run entirely", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    const run = makeRun();
    await repo.create(run);
    await repo.delete(run.id);
    expect(await repo.get(run.id)).toBeNull();
  });

  it("findBySessionId() returns every SessionReplayRun for that recording, none for another", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    const sessionId = randomUUID();
    const first = makeRun({ sessionId });
    const second = makeRun({ sessionId });
    const otherSession = makeRun({ sessionId: randomUUID() });
    await repo.create(first);
    await repo.create(second);
    await repo.create(otherSession);

    const results = await repo.findBySessionId(sessionId);
    expect(results.map((run) => run.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("findIdsByCycleId returns only runs stamped with that cycleId, and list()'s cycleId filter matches", async () => {
    const repo = new SessionReplayRunRepo(connection.db);
    const cycleA = randomUUID();
    const cycleB = randomUUID();
    const runA1 = makeRun({ cycleId: cycleA, replayRunNumber: 1 });
    const runA2 = makeRun({ cycleId: cycleA, replayRunNumber: 2 });
    const runB = makeRun({ cycleId: cycleB, replayRunNumber: 1 });
    const uncycled = makeRun();
    await Promise.all([repo.create(runA1), repo.create(runA2), repo.create(runB), repo.create(uncycled)]);

    const ids = await repo.findIdsByCycleId(cycleA);
    expect(ids.sort()).toEqual([runA1.id, runA2.id].sort());

    const listed = await repo.list({ limit: 25, offset: 0, cycleId: cycleA });
    expect(listed.total).toBe(2);
    expect(listed.sessionReplayRuns.map((run) => run.id).sort()).toEqual([runA1.id, runA2.id].sort());
  });
});
