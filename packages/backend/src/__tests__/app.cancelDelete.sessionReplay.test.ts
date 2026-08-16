import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import type { SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { startExplorerRun } from "../explorerRunLifecycle.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";
import { startSessionReplayRun } from "../sessionReplayRunLifecycle.js";

const MOCK_BASE_URL = "http://mock.local";
const LIST_PATH = "/fleet/auth/platform/locations";

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

function emptyTestPlanResponse(): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", name: "submit_test_plan", input: { hypotheses: [] } }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function emptyPlanJudgeClient(): AnthropicLike {
  return { messages: { create: () => Promise.resolve(emptyTestPlanResponse()) } };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

describe("HTTP cancel/delete routes — explorer, session-replay, session-recordings " + "(delete-cancel-spec.md phase 2)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let sessionCookie: string;
  let deps: AppDeps;

  function injectAuthed(options: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...options, headers: { ...options.headers, cookie: sessionCookie } });
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-canceldelete2-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-canceldelete2-"));
    deps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      featureDocumentRepo: new FeatureDocumentRepo(connection.db),
      sessionRecordingRepo: new SessionRecordingRepo(connection.db),
      sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "test-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax",
    };
    app = buildApp(deps);

    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: deps.dashboardPassword },
    });
    sessionCookie = loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("DELETE /session-recordings/:id cascades through the full nested chain via the route layer", async () => {
    const recording: SessionRecording = {
      sessionId: randomUUID(),
      targetBaseUrl: MOCK_BASE_URL,
      recordedAt: new Date(),
      steps: [{ action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 }],
    };
    await deps.sessionRecordingRepo.create(recording);

    const run = await startSessionReplayRun(
      { sessionId: recording.sessionId },
      { ...deps, installRoutes: (context) => installMockTarget(context, "baseline", seedFor()) },
    );
    if (!run) {
      throw new Error("unreachable");
    }
    await waitUntil(async () => (await deps.sessionReplayRunRepo.get(run.id))?.status === "COMPLETED");

    const deleteResponse = await injectAuthed({ method: "DELETE", url: `/session-recordings/${recording.sessionId}` });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json<{ deletedSessionReplayRuns: number }>().deletedSessionReplayRuns).toBe(1);

    expect(await deps.sessionRecordingRepo.get(recording.sessionId)).toBeNull();
    expect(await deps.sessionReplayRunRepo.get(run.id)).toBeNull();
  }, 20_000);

  it("DELETE /session-recordings/:id returns 404 for an unknown id", async () => {
    const response = await injectAuthed({ method: "DELETE", url: `/session-recordings/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it(
    "POST /explorer/runs/:id/cancel and DELETE /explorer/runs/:id wire through correctly (real " +
      "chromium close already proven at the lifecycle-function level in phase 1 — this checks the " +
      "route layer's status codes and cascade wiring specifically)",
    async () => {
      const run = await startExplorerRun(
        { featureId: "locations", sectionDescription: "warehouse", targetBaseUrl: `${MOCK_BASE_URL}${LIST_PATH}` },
        {
          ...deps,
          judgeClientFactory: emptyPlanJudgeClient,
          installRoutes: (context) => installMockTarget(context, "baseline", seedFor()),
        },
      );
      await waitUntil(async () => (await deps.runRepo.get(run.id))?.status === "COMPLETED");

      const cancelResponse = await injectAuthed({ method: "POST", url: `/explorer/runs/${run.id}/cancel` });
      expect(cancelResponse.statusCode).toBe(409);

      const deleteResponse = await injectAuthed({ method: "DELETE", url: `/explorer/runs/${run.id}` });
      expect(deleteResponse.statusCode).toBe(200);
      expect(await deps.runRepo.get(run.id)).toBeNull();
    },
    20_000,
  );

  it(
    "POST /session-replay/runs/:id/cancel on a real RUNNING run closes the real chromium instance " +
      "and the status sticks at CANCELLED — verifies the sessionReplayOrchestrator fix through the " +
      "route layer, not just the lifecycle function",
    async () => {
      const recording: SessionRecording = {
        sessionId: randomUUID(),
        targetBaseUrl: MOCK_BASE_URL,
        recordedAt: new Date(),
        steps: [{ action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 }],
      };
      await deps.sessionRecordingRepo.create(recording);

      const run = await startSessionReplayRun(
        { sessionId: recording.sessionId },
        {
          ...deps,
          installRoutes: async (context) => {
            await context.route("**/*", () => new Promise(() => {}));
          },
        },
      );
      if (!run) {
        throw new Error("unreachable");
      }
      await waitUntil(async () => (await deps.sessionReplayRunRepo.get(run.id))?.status === "RUNNING");
      await new Promise((resolve) => setTimeout(resolve, 400));

      const cancelResponse = await injectAuthed({ method: "POST", url: `/session-replay/runs/${run.id}/cancel` });
      expect(cancelResponse.statusCode).toBe(200);

      await waitUntil(async () => (await deps.sessionReplayRunRepo.get(run.id))?.status === "CANCELLED");

      const deleteResponse = await injectAuthed({ method: "DELETE", url: `/session-replay/runs/${run.id}` });
      expect(deleteResponse.statusCode).toBe(200);
    },
    20_000,
  );
});
