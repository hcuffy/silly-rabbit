import type { Finding, Run, SessionRecording, SessionReplayRun, TestRun } from "@silly-rabbit/shared";
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

describe("cascadeDelete — mid-crash safety (delete-cancel-spec.md §8, non-atomic by real infra constraint)", () => {
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

  it(
    "deleteRunCascade: a crash right before the final Run delete leaves Findings+TestRun already " +
      "gone but the Run still present (safe-partial, not corrupted) — a retry then finishes the job",
    async () => {
      const run = makeRun();
      await runRepo.create(run);
      const testRun: TestRun = {
        id: randomUUID(),
        featureId: "locations",
        runId: run.id,
        research: {
          featureId: "locations",
          sectionUrl: "https://dev.rabbit.example/fleet/locations",
          sectionHeading: "Locations",
          detectedLanguage: "en",
          elements: [],
          entityFields: [],
          ariaSnapshotMasked: "- heading",
          capturedAt: new Date(),
        },
        testPlan: [],
        checkOutcomes: [],
        findingIds: [],
        startedAt: new Date(),
        status: "COMPLETED",
      };
      await testRunRepo.create(testRun);
      const finding = makeFinding({ runId: run.id });
      await findingRepo.upsert(finding);

      const crashingRunRepo = {
        ...runRepo,
        delete: () => {
          throw new Error("simulated crash right before the final parent delete");
        },
      } as unknown as RunRepo;

      await expect(deleteRunCascade(run.id, { runRepo: crashingRunRepo, testRunRepo, findingRepo })).rejects.toThrow("simulated crash");

      expect(await findingRepo.get(finding.id)).toBeNull();
      expect(await testRunRepo.get(testRun.id)).toBeNull();
      expect(await runRepo.get(run.id)).not.toBeNull();

      const retryResult = await deleteRunCascade(run.id, { runRepo, testRunRepo, findingRepo });
      expect(retryResult).toEqual({ deletedFindings: 0, deletedTestRun: false });
      expect(await runRepo.get(run.id)).toBeNull();
    },
  );

  it(
    "deleteSessionReplayRunCascade: a crash right before the final run delete leaves its Findings " +
      "already gone but the run still present; a retry finishes the job",
    async () => {
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

      const crashingRepo = {
        ...sessionReplayRunRepo,
        delete: () => {
          throw new Error("simulated crash right before the final parent delete");
        },
      } as unknown as SessionReplayRunRepo;

      await expect(deleteSessionReplayRunCascade(run.id, { sessionReplayRunRepo: crashingRepo, findingRepo })).rejects.toThrow("simulated crash");

      expect(await findingRepo.findByRunIds([run.id])).toHaveLength(0);
      expect(await sessionReplayRunRepo.get(run.id)).not.toBeNull();

      const retryResult = await deleteSessionReplayRunCascade(run.id, { sessionReplayRunRepo, findingRepo });
      expect(retryResult).toEqual({ deletedFindings: 0 });
      expect(await sessionReplayRunRepo.get(run.id)).toBeNull();
    },
  );

  it(
    "deleteSessionRecordingCascade: a crash right before the final recording delete leaves its " +
      "SessionReplayRuns (+ their Findings) already gone but the recording still present; a retry " +
      "finishes the job",
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

      const crashingRecordingRepo = {
        ...sessionRecordingRepo,
        delete: () => {
          throw new Error("simulated crash right before the final parent delete");
        },
      } as unknown as SessionRecordingRepo;

      await expect(
        deleteSessionRecordingCascade(recording.sessionId, {
          sessionReplayRunRepo,
          findingRepo,
          sessionRecordingRepo: crashingRecordingRepo,
        }),
      ).rejects.toThrow("simulated crash");

      expect(await sessionReplayRunRepo.get(replayRun.id)).toBeNull();
      expect(await sessionRecordingRepo.get(recording.sessionId)).not.toBeNull();

      const retryResult = await deleteSessionRecordingCascade(recording.sessionId, {
        sessionReplayRunRepo,
        findingRepo,
        sessionRecordingRepo,
      });
      expect(retryResult).toEqual({ deletedSessionReplayRuns: 0, deletedFindings: 0 });
      expect(await sessionRecordingRepo.get(recording.sessionId)).toBeNull();
    },
  );
});
