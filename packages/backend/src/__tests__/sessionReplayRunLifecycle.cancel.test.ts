import type { AnthropicLike } from "@silly-rabbit/engine";
import type { SessionRecording, SessionReplayRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelSessionReplayRun, startSessionReplayRun, type SessionReplayRunLifecycleDeps } from "../sessionReplayRunLifecycle.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";

const MOCK_BASE_URL = "http://mock.local/";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test");
      },
    },
  };
}

async function waitForStatus(sessionReplayRunRepo: SessionReplayRunRepo, id: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await sessionReplayRunRepo.get(id);
    if (run?.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session-replay run ${id} never reached status ${status}`);
}

async function waitForTerminal(sessionReplayRunRepo: SessionReplayRunRepo, id: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await sessionReplayRunRepo.get(id);
    if (run && run.status !== "PENDING" && run.status !== "RUNNING") {
      return run.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session-replay run ${id} never reached a terminal state`);
}

describe("sessionReplayRunLifecycle — cancelSessionReplayRun (delete-cancel-spec.md §4, phase 1)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let deps: SessionReplayRunLifecycleDeps;
  let sessionRecordingRepo: SessionRecordingRepo;
  let sessionReplayRunRepo: SessionReplayRunRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    sessionRecordingRepo = new SessionRecordingRepo(connection.db);
    sessionReplayRunRepo = new SessionReplayRunRepo(connection.db);
    deps = {
      sessionRecordingRepo,
      sessionReplayRunRepo,
      baselineRepo: new BaselineRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
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
    "FIXED (was a documented known gap): cancelling mid-run now sticks — runSessionReplay checks real " +
      "current DB status before its final write, so the step loop's own per-step resilience absorbing the " +
      "browser.close()-triggered rejection no longer lets its unconditional COMPLETED write clobber the " +
      "CANCELLED status cancelSessionReplayRun() already wrote",
    async () => {
      const sessionRecording: SessionRecording = {
        sessionId: randomUUID(),
        targetBaseUrl: MOCK_BASE_URL,
        recordedAt: new Date(),
        steps: [{ action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 }],
      };
      await sessionRecordingRepo.create(sessionRecording);

      const run = await startSessionReplayRun(
        { sessionId: sessionRecording.sessionId },
        {
          ...deps,
          installRoutes: async (context) => {
            await context.route("**/*", () => new Promise(() => {}));
          },
        },
      );
      if (!run) {
        throw new Error("unreachable — sessionRecording was just created");
      }

      await waitForStatus(sessionReplayRunRepo, run.id, "RUNNING");
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(await cancelSessionReplayRun(run.id, deps)).toBe(true);

      const finalStatus = await waitForTerminal(sessionReplayRunRepo, run.id);
      expect(finalStatus).toBe("CANCELLED");
      expect((await sessionReplayRunRepo.get(run.id))?.completedAt).toBeInstanceOf(Date);
    },
    20_000,
  );

  it(
    "the early-exit between-steps check actually kicks in — a 3-step recording where step 1 hangs " +
      "ends CANCELLED with fewer than 3 steps counted in the summary, proving the loop stopped rather " +
      "than grinding through steps 2 and 3 against the already-closed browser (each of which would " +
      "individually throw and degrade to a step-error result on its own — confirmed empirically that " +
      "Playwright calls against a closed page/context/browser throw immediately — so this is a real " +
      "early-exit, not just an artifact of there being only one step to begin with)",
    async () => {
      const sessionRecording: SessionRecording = {
        sessionId: randomUUID(),
        targetBaseUrl: MOCK_BASE_URL,
        recordedAt: new Date(),
        steps: [
          { action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 },
          { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 500 },
          { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Confirm", timestampOffsetMs: 1000 },
        ],
      };
      await sessionRecordingRepo.create(sessionRecording);

      const run = await startSessionReplayRun(
        { sessionId: sessionRecording.sessionId },
        {
          ...deps,
          installRoutes: async (context) => {
            await context.route("**/*", () => new Promise(() => {}));
          },
        },
      );
      if (!run) {
        throw new Error("unreachable — sessionRecording was just created");
      }

      await waitForStatus(sessionReplayRunRepo, run.id, "RUNNING");
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(await cancelSessionReplayRun(run.id, deps)).toBe(true);

      const finalStatus = await waitForTerminal(sessionReplayRunRepo, run.id);
      expect(finalStatus).toBe("CANCELLED");

      const final = await sessionReplayRunRepo.get(run.id);
      const totalStepsCounted = (final?.summary.stepsExecuted ?? 0) + (final?.summary.stepsDrifted ?? 0) + (final?.summary.stepsErrored ?? 0);
      expect(totalStepsCounted).toBeLessThan(3);
    },
    20_000,
  );

  it("returns false for an already-COMPLETED run", async () => {
    const run: SessionReplayRun = {
      id: randomUUID(),
      sessionId: randomUUID(),
      replayMode: "live",
      status: "COMPLETED",
      startedAt: new Date(),
      completedAt: new Date(),
      summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
    };
    await sessionReplayRunRepo.create(run);

    expect(await cancelSessionReplayRun(run.id, deps)).toBe(false);
    expect((await sessionReplayRunRepo.get(run.id))?.status).toBe("COMPLETED");
  });

  it("returns false for an unknown id", async () => {
    expect(await cancelSessionReplayRun(randomUUID(), deps)).toBe(false);
  });
});
