import type { Finding, Run, SessionRecording, SessionReplayRun, TestRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteRunCascade, deleteSessionRecordingCascade, deleteSessionReplayRunCascade } from "../cascadeDelete.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

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

function makeReplayRun(overrides: Partial<SessionReplayRun> = {}): SessionReplayRun {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    replayMode: "live",
    status: "COMPLETED",
    startedAt: new Date(),
    summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
    ...overrides,
  };
}

describe("cascadeDelete (delete-cancel-spec.md §5, phase 1) — real Mongo + real files on disk", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let runRepo: RunRepo;
  let testRunRepo: TestRunRepo;
  let sessionReplayRunRepo: SessionReplayRunRepo;
  let sessionRecordingRepo: SessionRecordingRepo;
  let findingRepo: FindingRepo;
  let screenshotDirectory: string;

  async function makeFindingWithFiles(overrides: Partial<Finding>): Promise<Finding> {
    const screenshotPath = join(screenshotDirectory, `${randomUUID()}.png`);
    const reproSpecPath = join(screenshotDirectory, `${randomUUID()}.spec.ts`);
    await writeFile(screenshotPath, "fake-png-bytes");
    await writeFile(reproSpecPath, "test('x', () => {});");
    const finding: Finding = {
      id: randomUUID(),
      runId: "unset",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      evidence: {},
      dedupKey: `dedup-${randomUUID()}`,
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
      screenshotPath,
      reproSpecPath,
      ...overrides,
    };
    await findingRepo.upsert(finding);
    return finding;
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cascade-"));
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

  it("deleteRunCascade removes the Run, its Findings (+ files on disk), and its TestRun", async () => {
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
    const finding = await makeFindingWithFiles({ runId: run.id });

    expect(await fileExists(finding.screenshotPath as string)).toBe(true);

    const result = await deleteRunCascade(run.id, { runRepo, testRunRepo, findingRepo });
    expect(result).toEqual({ deletedFindings: 1, deletedTestRun: true });

    expect(await runRepo.get(run.id)).toBeNull();
    expect(await testRunRepo.get(testRun.id)).toBeNull();
    expect(await findingRepo.get(finding.id)).toBeNull();
    expect(await fileExists(finding.screenshotPath as string)).toBe(false);
    expect(await fileExists(finding.reproSpecPath as string)).toBe(false);
  });

  it("deleteRunCascade on a Run with no TestRun and no Findings reports zero counts, still deletes the Run", async () => {
    const run = makeRun();
    await runRepo.create(run);

    const result = await deleteRunCascade(run.id, { runRepo, testRunRepo, findingRepo });
    expect(result).toEqual({ deletedFindings: 0, deletedTestRun: false });
    expect(await runRepo.get(run.id)).toBeNull();
  });

  it("deleteSessionReplayRunCascade removes the run and its Findings (+ files)", async () => {
    const replayRun = makeReplayRun();
    await sessionReplayRunRepo.create(replayRun);
    const finding = await makeFindingWithFiles({ runId: replayRun.id, origin: "session-replay" });

    const result = await deleteSessionReplayRunCascade(replayRun.id, { sessionReplayRunRepo, findingRepo });
    expect(result).toEqual({ deletedFindings: 1 });

    expect(await sessionReplayRunRepo.get(replayRun.id)).toBeNull();
    expect(await findingRepo.get(finding.id)).toBeNull();
    expect(await fileExists(finding.screenshotPath as string)).toBe(false);
  });

  it("deleteSessionRecordingCascade chains correctly through the full nested chain: " +
    "SessionRecording -> N SessionReplayRuns -> each run's own Findings (+ files) — the exact gap the " +
    "original audit found (steps degrading to [] on read) no longer applies because nothing is left to read", async () => {
    const recording: SessionRecording = {
      sessionId: randomUUID(),
      targetBaseUrl: "https://dev.rabbit.example",
      recordedAt: new Date(),
      steps: [{ action: "navigate", selectorStrategy: "css", value: "https://dev.rabbit.example", timestampOffsetMs: 0 }],
    };
    await sessionRecordingRepo.create(recording);

    const replayRunA = makeReplayRun({ sessionId: recording.sessionId });
    const replayRunB = makeReplayRun({ sessionId: recording.sessionId });
    const unrelatedReplayRun = makeReplayRun({ sessionId: randomUUID() });
    await sessionReplayRunRepo.create(replayRunA);
    await sessionReplayRunRepo.create(replayRunB);
    await sessionReplayRunRepo.create(unrelatedReplayRun);

    const findingA = await makeFindingWithFiles({ runId: replayRunA.id, origin: "session-replay" });
    const findingB1 = await makeFindingWithFiles({ runId: replayRunB.id, origin: "session-replay" });
    const findingB2 = await makeFindingWithFiles({ runId: replayRunB.id, origin: "session-replay" });
    const unrelatedFinding = await makeFindingWithFiles({ runId: unrelatedReplayRun.id, origin: "session-replay" });

    const result = await deleteSessionRecordingCascade(recording.sessionId, {
      sessionReplayRunRepo,
      findingRepo,
      sessionRecordingRepo,
    });
    expect(result).toEqual({ deletedSessionReplayRuns: 2, deletedFindings: 3 });

    expect(await sessionRecordingRepo.get(recording.sessionId)).toBeNull();
    expect(await sessionReplayRunRepo.get(replayRunA.id)).toBeNull();
    expect(await sessionReplayRunRepo.get(replayRunB.id)).toBeNull();
    expect(await findingRepo.get(findingA.id)).toBeNull();
    expect(await findingRepo.get(findingB1.id)).toBeNull();
    expect(await findingRepo.get(findingB2.id)).toBeNull();
    expect(await fileExists(findingA.screenshotPath as string)).toBe(false);
    expect(await fileExists(findingB1.screenshotPath as string)).toBe(false);

    expect(await sessionReplayRunRepo.get(unrelatedReplayRun.id)).not.toBeNull();
    expect(await findingRepo.get(unrelatedFinding.id)).not.toBeNull();
    expect(await fileExists(unrelatedFinding.screenshotPath as string)).toBe(true);
  });
});
