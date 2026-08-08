import type { Learning, Run } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteRunCascade } from "../cascadeDelete.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
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

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  const now = new Date();
  return {
    id: randomUUID(),
    featureId: "locations",
    learningType: "confirmed_issue",
    description: "the name field silently accepts an empty value",
    source: "run_verdict",
    firstSeenRunId: "run-1",
    lastConfirmedRunId: "run-1",
    status: "active",
    dedupKey: `dedup-${randomUUID()}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("cascadeDelete — Learning.firstSeenRunId/lastConfirmedRunId dangling reference " +
  "(delete-cancel-spec.md §5, deliberate, documented behavior)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let runRepo: RunRepo;
  let testRunRepo: TestRunRepo;
  let findingRepo: FindingRepo;
  let learningRepo: LearningRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    runRepo = new RunRepo(connection.db);
    testRunRepo = new TestRunRepo(connection.db);
    findingRepo = new FindingRepo(connection.db);
    learningRepo = new LearningRepo(connection.db);
  });

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("a Learning referencing a Run survives that Run's cascade-delete, with " +
    "firstSeenRunId/lastConfirmedRunId left unchanged (now dangling) — deliberate, not an oversight", async () => {
    const run = makeRun();
    await runRepo.create(run);

    const learning = makeLearning({ firstSeenRunId: run.id, lastConfirmedRunId: run.id });
    await learningRepo.upsert(learning);

    await deleteRunCascade(run.id, { runRepo, testRunRepo, findingRepo });

    expect(await runRepo.get(run.id)).toBeNull();

    const survivingLearning = await learningRepo.findByDedupKey(learning.featureId, learning.dedupKey as string);
    expect(survivingLearning).not.toBeNull();
    expect(survivingLearning?.firstSeenRunId).toBe(run.id);
    expect(survivingLearning?.lastConfirmedRunId).toBe(run.id);
  });
});
