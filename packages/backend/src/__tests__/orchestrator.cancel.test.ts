import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { cancelRun, startRun, type OrchestratorDeps } from "../orchestrator.js";
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
    if (run?.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never reached status ${status}`);
}

describe("orchestrator — cancelRun (delete-cancel-spec.md §4, phase 1), real chromium", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let deps: OrchestratorDeps;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-cancel-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-cancel-"));
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
    };
  }, 30_000);

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it(
    "cancelling a run whose target never responds actually closes the real chromium instance — the " +
      "run reaches CANCELLED instead of hanging forever, proving a real close happened, not just a " +
      "status flip (a hung route with no cancel would never resolve and this test would time out)",
    async () => {
      const run = await startRun(
        { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
        {
          ...deps,
          installRoutes: async (context) => {
            await context.route("**/*", () => new Promise(() => {}));
          },
        },
      );

      await waitForStatus(deps.runRepo, run.id, "RUNNING");
      await new Promise((resolve) => setTimeout(resolve, 400)); // let chromium.launch() + the hung navigation actually start

      const cancelled = await cancelRun(run.id, deps);
      expect(cancelled).toBe(true);

      await waitForStatus(deps.runRepo, run.id, "CANCELLED");
      const final = await deps.runRepo.get(run.id);
      expect(final?.finishedAt).toBeInstanceOf(Date);
    },
    20_000,
  );

  it(
    "cancelling immediately after trigger reaches CANCELLED without ever completing real work — best " +
      "effort on the exact PENDING/RUNNING boundary (which resolves in microseconds and can't be pinned " +
      "deterministically from outside), but the observable outcome is deterministic: no findings, " +
      "stepsUsed stays 0",
    async () => {
      const run = await startRun(
        { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
        {
          ...deps,
          installRoutes: async (context) => {
            await context.route("**/*", () => new Promise(() => {}));
          },
        },
      );

      const cancelled = await cancelRun(run.id, deps);
      expect(cancelled).toBe(true);

      await waitForStatus(deps.runRepo, run.id, "CANCELLED");
      const final = await deps.runRepo.get(run.id);
      expect(final?.stepsUsed).toBe(0);
      expect(await deps.findingRepo.listByRun(run.id)).toHaveLength(0);
    },
    20_000,
  );

  it("cancelRun returns false and does not disturb an already-COMPLETED run", async () => {
    const run = await startRun(
      { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
      { ...deps, installRoutes: (context) => installMockTarget(context, "baseline", seedFor()) },
    );
    await waitForStatus(deps.runRepo, run.id, "COMPLETED");

    expect(await cancelRun(run.id, deps)).toBe(false);
    expect((await deps.runRepo.get(run.id))?.status).toBe("COMPLETED");
  }, 20_000);

  it("cancelRun returns false for an unknown run id", async () => {
    expect(await cancelRun("00000000-0000-0000-0000-000000000000", deps)).toBe(false);
  });
});
