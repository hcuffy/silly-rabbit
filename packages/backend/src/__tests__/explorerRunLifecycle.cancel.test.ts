import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Run, TestRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelExplorerRun, startExplorerRun, type ExplorerRunLifecycleDeps } from "../explorerRunLifecycle.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const MOCK_BASE_URL = "http://mock.local";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test");
      },
    },
  };
}

async function waitForStatus(runRepo: RunRepo, runId: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await runRepo.get(runId);
    if (run?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never reached status ${status}`);
}

describe("explorerRunLifecycle — cancelExplorerRun (delete-cancel-spec.md §4, phase 1)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let deps: ExplorerRunLifecycleDeps;
  let runRepo: RunRepo;
  let testRunRepo: TestRunRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    runRepo = new RunRepo(connection.db);
    testRunRepo = new TestRunRepo(connection.db);
    deps = {
      runRepo,
      testRunRepo,
      learningRepo: new LearningRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      screenshotDirectory: "/tmp/silly-rabbit-explorer-cancel-screenshots",
      screenshotStorageCapBytes: 1_000_000_000,
    };
  }, 30_000);

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("cancelling while stuck on the initial navigation actually closes the real chromium instance — " +
    "the Run reaches CANCELLED rather than hanging forever, and no TestRun is ever created (cancelled " +
    "before locateSection could get that far)", async () => {
    const run = await startExplorerRun(
      { featureId: "locations", sectionDescription: "warehouse", targetBaseUrl: MOCK_BASE_URL },
      { ...deps, installRoutes: async (context) => { await context.route("**/*", () => new Promise(() => {})); } },
    );

    await waitForStatus(runRepo, run.id, "RUNNING");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await cancelExplorerRun(run.id, deps)).toBe(true);
    await waitForStatus(runRepo, run.id, "CANCELLED");

    expect(await testRunRepo.getByRunId(run.id)).toBeNull();
  }, 20_000);

  it("cancels both the Run and its TestRun together — proven against a directly-seeded RUNNING pair, " +
    "no live browser involved, the same degrade-gracefully path a stale post-crash RUNNING record " +
    "would go through (no registry entry, DB-level cancel is still the source of truth)", async () => {
    const run: Run = {
      id: randomUUID(),
      charter: "explorer: locations",
      targetBaseUrl: MOCK_BASE_URL,
      status: "RUNNING",
      startedAt: new Date(),
      stepsUsed: 0,
      llmCallsUsed: 0,
      costUsd: 0,
    };
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
      status: "RUNNING",
    };
    await testRunRepo.create(testRun);

    expect(await cancelExplorerRun(run.id, deps)).toBe(true);

    expect((await runRepo.get(run.id))?.status).toBe("CANCELLED");
    expect((await testRunRepo.get(testRun.id))?.status).toBe("CANCELLED");
  });

  it("returns false for an already-COMPLETED run, does not touch its TestRun", async () => {
    const run: Run = {
      id: randomUUID(),
      charter: "explorer: locations",
      targetBaseUrl: MOCK_BASE_URL,
      status: "COMPLETED",
      startedAt: new Date(),
      finishedAt: new Date(),
      stepsUsed: 2,
      llmCallsUsed: 1,
      costUsd: 0.01,
    };
    await runRepo.create(run);

    expect(await cancelExplorerRun(run.id, deps)).toBe(false);
    expect((await runRepo.get(run.id))?.status).toBe("COMPLETED");
  });
});
