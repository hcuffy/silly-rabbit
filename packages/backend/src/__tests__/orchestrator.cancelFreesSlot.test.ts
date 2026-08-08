import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { cancelRun, RunCapacityError, startRun, type OrchestratorDeps } from "../orchestrator.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { RunRepo } from "../repos/runRepo.js";

const MOCK_BASE_URL = "http://mock.local";

function seedFor(): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 1 };
}

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

describe("cancelling a RUNNING run frees its reserveRunSlot() concurrency slot — real interaction " +
  "between the resource-exhaustion fix and the cancel feature, built in separate sessions", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let deps: OrchestratorDeps;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-slot-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-slot-"));
    deps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      maxConcurrentRuns: 1,
    };
  }, 30_000);

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("cap=1: a 2nd trigger is rejected while the 1st is stuck RUNNING; cancelling the 1st frees the " +
    "slot so a 3rd trigger now succeeds", async () => {
    const first = await startRun(
      { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
      { ...deps, installRoutes: async (context) => { await context.route("**/*", () => new Promise(() => {})); } },
    );
    await waitForStatus(deps.runRepo, first.id, "RUNNING");
    await new Promise((resolve) => setTimeout(resolve, 400));

    await expect(
      startRun({ charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL }, deps),
    ).rejects.toBeInstanceOf(RunCapacityError);

    expect(await cancelRun(first.id, deps)).toBe(true);
    await waitForStatus(deps.runRepo, first.id, "CANCELLED");

    const third = await startRun(
      { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
      { ...deps, installRoutes: (context) => installMockTarget(context, "baseline", seedFor()) },
    );
    await waitForStatus(deps.runRepo, third.id, "COMPLETED");
  }, 20_000);
});
