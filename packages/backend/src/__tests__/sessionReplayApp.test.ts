import type { AnthropicLike } from "@silly-rabbit/engine";
import type { SessionRecording, SessionReplayRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const MOCK_BASE_URL = "https://replay.local/";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test — no divergence expected");
      },
    },
  };
}

interface TriggerResponseBody {
  runId: string;
  status: string;
}

async function waitUntilTerminal(app: FastifyInstance, runId: string, sessionCookie: string): Promise<SessionReplayRun> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await app.inject({
      method: "GET",
      url: `/session-replay/runs/${runId}`,
      headers: { cookie: sessionCookie },
    });
    const body = response.json<SessionReplayRun>();
    if (body.status === "COMPLETED" || body.status === "FAILED") return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`session-replay run ${runId} did not reach a terminal state in time`);
}

function makeSessionRecording(overrides: Partial<SessionRecording> = {}): SessionRecording {
  return {
    sessionId: randomUUID(),
    targetBaseUrl: MOCK_BASE_URL,
    recordedAt: new Date(),
    steps: [
      { action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 },
      { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 500 },
    ],
    ...overrides,
  };
}

describe("Fastify app — session-replay routes (dashboard-integration slice 1, session-replay-spec §8)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let sessionCookie: string;
  let deps: AppDeps;
  let sessionRecordingRepo: SessionRecordingRepo;

  function injectAuthed(options: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...options, headers: { ...options.headers, cookie: sessionCookie } });
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    sessionRecordingRepo = new SessionRecordingRepo(connection.db);
    deps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      featureDocumentRepo: new FeatureDocumentRepo(connection.db),
      sessionRecordingRepo,
      sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      reproSpecDirectory: "./repro-specs-session-replay-app-test",
      screenshotDirectory: "./screenshots-session-replay-app-test",
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["replay.local"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "test-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax",
      installRoutes: async (context) => {
        await context.route(`${MOCK_BASE_URL}**`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<html><body><h1>Locations</h1><button aria-label="Save">Save</button></body></html>`,
          }),
        );
      },
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

  it("rejects an invalid POST /session-replay/runs body with structured JSON, not a stack trace", async () => {
    const response = await injectAuthed({ method: "POST", url: "/session-replay/runs", payload: { sessionId: "not-a-uuid" } });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string }>();
    expect(body.error).toBeTruthy();
    expect(body).not.toHaveProperty("stack");
  });

  it("POST /session-replay/runs 404s for a sessionId with no matching SessionRecording", async () => {
    const response = await injectAuthed({ method: "POST", url: "/session-replay/runs", payload: { sessionId: randomUUID() } });
    expect(response.statusCode).toBe(404);
  });

  it("GET /session-replay/runs/:id 404s for an unknown run id", async () => {
    const response = await injectAuthed({ method: "GET", url: `/session-replay/runs/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it("triggers a real replay against the mock target, reaches COMPLETED, and GET returns the run plus " +
    "its findings in the shape the (future) frontend will need", async () => {
    const sessionRecording = makeSessionRecording();
    await sessionRecordingRepo.create(sessionRecording);

    const postResponse = await injectAuthed({
      method: "POST",
      url: "/session-replay/runs",
      payload: { sessionId: sessionRecording.sessionId, replayMode: "live" },
    });
    expect(postResponse.statusCode).toBe(202);
    const { runId, status } = postResponse.json<TriggerResponseBody>();
    expect(["PENDING", "RUNNING"]).toContain(status);

    const final = await waitUntilTerminal(app, runId, sessionCookie);
    expect(final.status).toBe("COMPLETED");
    expect(final.replayMode).toBe("live");
    expect(final.sessionId).toBe(sessionRecording.sessionId);
    expect(final.summary.stepsExecuted).toBe(2);
    expect(final.completedAt).toBeTruthy();

    const getResponse = await injectAuthed({ method: "GET", url: `/session-replay/runs/${runId}` });
    const body = getResponse.json<SessionReplayRun & { findings: unknown[]; steps: unknown[] }>();
    expect(body.id).toBe(runId);
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.steps).toEqual(sessionRecording.steps);
  }, 15_000);

  it("GET /session-recordings lists recordings, newest first", async () => {
    const recording = makeSessionRecording();
    await sessionRecordingRepo.create(recording);

    const response = await injectAuthed({ method: "GET", url: "/session-recordings" });
    expect(response.statusCode).toBe(200);
    const body = response.json<SessionRecording[]>();
    expect(body.some((entry) => entry.sessionId === recording.sessionId)).toBe(true);
  });

  it("session-replay routes are behind the same global auth gate as every other route", async () => {
    const response = await app.inject({ method: "GET", url: "/session-recordings" });
    expect(response.statusCode).toBe(401);
  });
});
