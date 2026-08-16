import type { Finding, Run, SessionRecording, SessionReplayRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteRunCascade, deleteSessionRecordingCascade, deleteSessionReplayRunCascade } from "../cascadeDelete.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    charter: "test the locations flow",
    targetBaseUrl: "http://mock.local",
    status: "COMPLETED",
    startedAt: new Date(),
    stepsUsed: 1,
    llmCallsUsed: 0,
    costUsd: 0,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    runId: "unset",
    screenId: "screen-1",
    type: "STATE_DIVERGENCE",
    evidence: {},
    dedupKey: `dedup-${randomUUID()}`,
    status: "NEW",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe(
  "cascadeDelete — concurrent double-submit returns the same real result from both callers, " + "deletes the underlying data exactly once",
  () => {
    let mongod: MongoMemoryServer;
    let connection: MongoConnection;
    let runRepo: RunRepo;
    let testRunRepo: TestRunRepo;
    let sessionReplayRunRepo: SessionReplayRunRepo;
    let sessionRecordingRepo: SessionRecordingRepo;
    let findingRepo: FindingRepo;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await connectMongo(mongod.getUri());
      runRepo = new RunRepo(connection.db);
      testRunRepo = new TestRunRepo(connection.db);
      sessionReplayRunRepo = new SessionReplayRunRepo(connection.db);
      sessionRecordingRepo = new SessionRecordingRepo(connection.db);
      findingRepo = new FindingRepo(connection.db);
    });

    afterAll(async () => {
      await closeMongo(connection);
      await mongod.stop();
    });

    it("deleteRunCascade: 2 concurrent calls on the same runId both return the identical real result, " + "not one real + one zeroed", async () => {
      const run = makeRun();
      await runRepo.create(run);
      const finding = makeFinding({ runId: run.id });
      await findingRepo.upsert(finding);

      const [resultA, resultB] = await Promise.all([
        deleteRunCascade(run.id, { runRepo, testRunRepo, findingRepo }),
        deleteRunCascade(run.id, { runRepo, testRunRepo, findingRepo }),
      ]);

      expect(resultA).toEqual({ deletedFindings: 1, deletedTestRun: false });
      expect(resultB).toEqual(resultA);
      expect(await runRepo.get(run.id)).toBeNull();
      expect(await findingRepo.get(finding.id)).toBeNull();
    });

    it("deleteSessionReplayRunCascade: 2 concurrent calls on the same runId both return the identical " + "real result", async () => {
      const run: SessionReplayRun = {
        id: randomUUID(),
        sessionId: randomUUID(),
        replayMode: "live",
        status: "COMPLETED",
        startedAt: new Date(),
        summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
      };
      await sessionReplayRunRepo.create(run);
      await findingRepo.upsert(makeFinding({ runId: run.id, origin: "session-replay" }));

      const [resultA, resultB] = await Promise.all([
        deleteSessionReplayRunCascade(run.id, { sessionReplayRunRepo, findingRepo }),
        deleteSessionReplayRunCascade(run.id, { sessionReplayRunRepo, findingRepo }),
      ]);

      expect(resultA).toEqual({ deletedFindings: 1 });
      expect(resultB).toEqual(resultA);
      expect(await sessionReplayRunRepo.get(run.id)).toBeNull();
    });

    it(
      "deleteSessionRecordingCascade: 2 concurrent calls on the same sessionId both return the " +
        "identical real result, nested SessionReplayRuns/Findings deleted exactly once",
      async () => {
        const recording: SessionRecording = {
          sessionId: randomUUID(),
          targetBaseUrl: "http://mock.local",
          recordedAt: new Date(),
          steps: [],
        };
        await sessionRecordingRepo.create(recording);
        const replayRun: SessionReplayRun = {
          id: randomUUID(),
          sessionId: recording.sessionId,
          replayMode: "live",
          status: "COMPLETED",
          startedAt: new Date(),
          summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
        };
        await sessionReplayRunRepo.create(replayRun);
        await findingRepo.upsert(makeFinding({ runId: replayRun.id, origin: "session-replay" }));

        const [resultA, resultB] = await Promise.all([
          deleteSessionRecordingCascade(recording.sessionId, { sessionReplayRunRepo, findingRepo, sessionRecordingRepo }),
          deleteSessionRecordingCascade(recording.sessionId, { sessionReplayRunRepo, findingRepo, sessionRecordingRepo }),
        ]);

        expect(resultA).toEqual({ deletedSessionReplayRuns: 1, deletedFindings: 1 });
        expect(resultB).toEqual(resultA);
        expect(await sessionRecordingRepo.get(recording.sessionId)).toBeNull();
        expect(await sessionReplayRunRepo.get(replayRun.id)).toBeNull();
      },
    );
  },
);
