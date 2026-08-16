import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import type { Run, SessionRecording, SessionReplayRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { RunCapacityError, startRun, type OrchestratorDeps } from "../orchestrator.js";
import { startSessionReplayRun, type SessionReplayRunLifecycleDeps } from "../sessionReplayRunLifecycle.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";

const MOCK_BASE_URL = "http://mock.local/";

function seedFor(): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 1 };
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

async function waitForRunTerminal(runRepo: RunRepo, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = await runRepo.get(runId);
    if (run && (run.status === "COMPLETED" || run.status === "FAILED")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

async function waitForReplayTerminal(sessionReplayRunRepo: SessionReplayRunRepo, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = await sessionReplayRunRepo.get(runId);
    if (run && (run.status === "COMPLETED" || run.status === "FAILED")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session-replay run ${runId} did not reach a terminal state in time`);
}

describe(
  "run-type concurrency cap is genuinely shared — a charter run (D1-D7) and a session-replay " +
    "run count against the same inFlightRuns-backed limit, not two independent counters",
  () => {
    let mongod: MongoMemoryServer;
    let connection: MongoConnection;
    let orchestratorDeps: OrchestratorDeps;
    let sessionReplayDeps: SessionReplayRunLifecycleDeps;
    let sessionRecording: SessionRecording;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await connectMongo(mongod.getUri());
      const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-crosscap-"));
      const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-crosscap-"));
      const sessionRecordingRepo = new SessionRecordingRepo(connection.db);

      const shared = {
        baselineRepo: new BaselineRepo(connection.db),
        findingRepo: new FindingRepo(connection.db),
        judgeClientFactory: throwingJudgeClient,
        allowedDomains: ["mock.local"],
        productionUrlPatterns: [] as RegExp[],
        maxConcurrentRuns: 1,
        installRoutes: (context: BrowserContext) => installMockTarget(context, "baseline", seedFor()),
      };
      orchestratorDeps = {
        ...shared,
        runRepo: new RunRepo(connection.db),
        appMapRepo: new AppMapRepo(connection.db),
        reproSpecDirectory,
        screenshotDirectory,
        screenshotStorageCapBytes: 1_000_000_000,
      };
      sessionReplayDeps = {
        ...shared,
        sessionRecordingRepo,
        sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      };

      sessionRecording = {
        sessionId: randomUUID(),
        targetBaseUrl: MOCK_BASE_URL,
        recordedAt: new Date(),
        steps: [{ action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 }],
      };
      await sessionRecordingRepo.create(sessionRecording);
    }, 30_000);

    afterAll(async () => {
      await closeMongo(connection);
      await mongod.stop();
    });

    it(
      "rejects a session-replay trigger fired while a charter run already holds the single shared slot, " +
        "then accepts a third trigger once the first one finishes",
      async () => {
        const [charterOutcome, replayOutcome] = await Promise.allSettled([
          startRun({ charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL }, orchestratorDeps),
          startSessionReplayRun({ sessionId: sessionRecording.sessionId }, sessionReplayDeps),
        ]);

        expect(charterOutcome.status).toBe("fulfilled");
        expect(replayOutcome.status).toBe("rejected");
        if (replayOutcome.status === "rejected") {
          expect(replayOutcome.reason).toBeInstanceOf(RunCapacityError);
          expect((replayOutcome.reason as Error).message).toContain("max concurrent runs");
        }

        const charterRun = (charterOutcome as PromiseFulfilledResult<Run>).value;
        await waitForRunTerminal(orchestratorDeps.runRepo, charterRun.id);

        const secondReplay = await startSessionReplayRun({ sessionId: sessionRecording.sessionId }, sessionReplayDeps);
        expect(secondReplay).toBeDefined();
        await waitForReplayTerminal(sessionReplayDeps.sessionReplayRunRepo, (secondReplay as SessionReplayRun).id);
      },
      30_000,
    );
  },
);
