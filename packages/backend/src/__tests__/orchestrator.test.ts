import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { getTriggeredBy, installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import type { Run } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { startRun, type OrchestratorDeps } from "../orchestrator.js";
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

function regressionJudgeClient(): AnthropicLike {
  const response: AnthropicMessageResponse = {
    content: [
      { type: "tool_use", name: "submit_verdict", input: { verdict: "REGRESSION", severity: "HIGH", reasoning: "button removed", confidence: 0.9 } },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  return { messages: { create: () => Promise.resolve(response) } };
}

async function waitForTerminal(runRepo: RunRepo, runId: string): Promise<Run> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = await runRepo.get(runId);
    if (run && (run.status === "COMPLETED" || run.status === "FAILED")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe("orchestrator (backend-spec §4) — D3 mock through the real engine, persisted to Mongo", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let deps: OrchestratorDeps;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-"));
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

  it("run 1 learns baselines+appMap; run 2 against an unchanged target reads them back from Mongo and suppresses", async () => {
    const baselineSeed = seedFor();
    const run1 = await startRun(
      { charter: CHARTER, targetBaseUrl: MOCK_BASE_URL },
      { ...deps, installRoutes: (context) => installMockTarget(context, "baseline", baselineSeed) },
    );
    const run1Final = await waitForTerminal(deps.runRepo, run1.id);
    expect(run1Final.status).toBe("COMPLETED");
    expect(run1Final.stepsUsed).toBeGreaterThan(0);
    expect(run1Final.triggeredBy).toBe(getTriggeredBy());

    const run1Findings = await deps.findingRepo.listByRun(run1.id);
    expect(run1Findings.filter((finding) => finding.type === "STATE_DIVERGENCE")).toHaveLength(0);

    const appMapAfterRun1 = await deps.appMapRepo.get();
    expect(appMapAfterRun1?.screens.length).toBe(1);

    const screenId = appMapAfterRun1?.screens[0]?.screenId;
    if (!screenId) throw new Error("unreachable — asserted screens.length above");
    const [baseline] = await deps.baselineRepo.getByScreenIds([screenId]);
    expect(baseline?.baselineScreenshotPath).toBeDefined();
    if (!baseline?.baselineScreenshotPath) throw new Error("unreachable — asserted above");
    const baselineScreenshotBytes = await readFile(baseline.baselineScreenshotPath);
    expect(baselineScreenshotBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const run2 = await startRun(
      { charter: CHARTER, targetBaseUrl: MOCK_BASE_URL },
      {
        ...deps,
        installRoutes: (context) =>
          installMockTarget(
            context,
            "volatile-only",
            seedFor({ timestamp: new Date(Date.now() + 60_000).toISOString() }),
          ),
      },
    );
    const run2Final = await waitForTerminal(deps.runRepo, run2.id);
    expect(run2Final.status).toBe("COMPLETED");

    const run2Findings = await deps.findingRepo.listByRun(run2.id);
    expect(run2Findings.filter((finding) => finding.type === "STATE_DIVERGENCE")).toHaveLength(0);

    const appMapAfterRun2 = await deps.appMapRepo.get();
    expect(appMapAfterRun2?.screens.length).toBe(1);
    expect(appMapAfterRun2?.id).toBe(appMapAfterRun1?.id);
  }, 30_000);

  it("a run against a changed target flags a NEW STATE_DIVERGENCE and writes a repro spec to disk", async () => {
    const priorRun = await startRun(
      { charter: CHARTER, targetBaseUrl: MOCK_BASE_URL },
      { ...deps, installRoutes: (context) => installMockTarget(context, "baseline", seedFor()) },
    );
    await waitForTerminal(deps.runRepo, priorRun.id);

    const changedRun = await startRun(
      { charter: CHARTER, targetBaseUrl: MOCK_BASE_URL },
      {
        ...deps,
        judgeClientFactory: regressionJudgeClient,
        installRoutes: (context) => installMockTarget(context, "changed-regression", seedFor()),
      },
    );
    const changedFinal = await waitForTerminal(deps.runRepo, changedRun.id);
    expect(changedFinal.status).toBe("COMPLETED");
    expect(changedFinal.llmCallsUsed).toBe(1);
    expect(changedFinal.costUsd).toBeGreaterThan(0);

    const findings = await deps.findingRepo.listByRun(changedRun.id);
    const divergence = findings.find((finding) => finding.type === "STATE_DIVERGENCE" && finding.status === "NEW");
    expect(divergence).toBeDefined();
    expect(divergence?.verdict).toBe("REGRESSION");
    expect(divergence?.reproSpecPath).toBeDefined();
    if (!divergence?.reproSpecPath) throw new Error("unreachable — asserted above");

    const reproContents = await readFile(divergence.reproSpecPath, "utf8");
    expect(reproContents).toContain("test(");
    expect(reproContents).toContain("deriveFingerprint");

    expect(divergence.screenshotPath).toBeDefined();
    if (!divergence.screenshotPath) throw new Error("unreachable — asserted above");
    const screenshotBytes = await readFile(divergence.screenshotPath);
    expect(screenshotBytes.length).toBeGreaterThan(0);
    expect(screenshotBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const [baseline] = await deps.baselineRepo.getByScreenIds([divergence.screenId]);
    expect(divergence.beforeScreenshotPath).toBe(baseline?.baselineScreenshotPath);
    expect(divergence.beforeScreenshotPath).not.toBe(divergence.screenshotPath);
  }, 30_000);

  it("a run that fails (bad charter) writes FAILED + error, never leaves the run stuck RUNNING", async () => {
    const run = await startRun({ charter: "no charter matches this", targetBaseUrl: MOCK_BASE_URL }, deps);
    const final = await waitForTerminal(deps.runRepo, run.id);
    expect(final.status).toBe("FAILED");
    expect(final.error).toBeTruthy();
  }, 30_000);

  it("a nonexistent storageState path is ignored, not thrown — the run proceeds without it", async () => {
    const run = await startRun(
      { charter: CHARTER, targetBaseUrl: MOCK_BASE_URL },
      {
        ...deps,
        storageState: join(tmpdir(), `silly-rabbit-nonexistent-storage-state-${randomUUID()}.json`),
        installRoutes: (context) => installMockTarget(context, "baseline", seedFor()),
      },
    );
    const final = await waitForTerminal(deps.runRepo, run.id);
    expect(final.status).toBe("COMPLETED");
    expect(final.stepsUsed).toBeGreaterThan(0);
  }, 30_000);
});
