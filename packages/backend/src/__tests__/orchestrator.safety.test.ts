import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import type { Run } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { startRun, waitForInFlightRuns, type OrchestratorDeps } from "../orchestrator.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { RunRepo } from "../repos/runRepo.js";

const MOCK_BASE_URL = "http://mock.local";
const CHARTER = "test the locations flow";

function seedFor(overrides: Partial<MockSeed> = {}): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 7, ...overrides };
}

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called — no divergence expected in this test");
      },
    },
  };
}

async function waitForTerminal(runRepo: RunRepo, runId: string): Promise<Run> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = await runRepo.get(runId);
    if (run && (run.status === "COMPLETED" || run.status === "FAILED")) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe("orchestrator safety floor (safety-spec §2/§3/§5)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let deps: OrchestratorDeps;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-safety-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-safety-"));
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

  it("an off-allowlist targetBaseUrl is refused before the browser ever launches", async () => {
    const run = await startRun({ charter: CHARTER, targetBaseUrl: "http://not-allowed.example" }, deps);
    const final = await waitForTerminal(deps.runRepo, run.id);

    expect(final.status).toBe("FAILED");
    expect(final.error).toContain("not on the domain allowlist");
    expect(final.stepsUsed).toBe(0);
  }, 15_000);

  it("an off-allowlist login URL is refused before the browser ever launches", async () => {
    const run = await startRun(
      { charter: CHARTER, targetBaseUrl: MOCK_BASE_URL },
      {
        ...deps,
        loginCreds: {
          loginUrl: "http://not-allowed.example/login",
          email: "test@example.com",
          password: "mock-password-not-real",
          emailSelector: "#email",
          passwordSelector: "#password",
          submitSelector: "#submit",
        },
      },
    );
    const final = await waitForTerminal(deps.runRepo, run.id);

    expect(final.status).toBe("FAILED");
    expect(final.error).toContain("not on the domain allowlist");
    expect(final.stepsUsed).toBe(0);
  }, 15_000);
  it("an allowlisted host that also matches a configured prod-URL pattern is refused before the browser ever launches", async () => {
    const run = await startRun({ charter: CHARTER, targetBaseUrl: MOCK_BASE_URL }, { ...deps, productionUrlPatterns: [/^mock\.local$/i] });
    const final = await waitForTerminal(deps.runRepo, run.id);

    expect(final.status).toBe("FAILED");
    expect(final.error).toContain("production-url pattern");
    expect(final.stepsUsed).toBe(0);
  }, 15_000);
});

describe("waitForInFlightRuns (audit #8)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let deps: OrchestratorDeps;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-inflight-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-inflight-"));
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

  it("a short timeout returns without waiting for the run to finish; a generous one waits for it", async () => {
    const startedAt = Date.now();
    const run = await startRun(
      { charter: CHARTER, targetBaseUrl: MOCK_BASE_URL },
      { ...deps, installRoutes: (context) => installMockTarget(context, "baseline", seedFor()) },
    );

    await waitForInFlightRuns(50);
    expect(Date.now() - startedAt).toBeLessThan(500);

    await waitForInFlightRuns(10_000);
    const final = await deps.runRepo.get(run.id);
    expect(final?.status).toBe("COMPLETED");
  }, 15_000);
});
