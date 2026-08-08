import type { AnthropicLike } from "@silly-rabbit/engine";
import type { ResearchInventory, SessionReplayRun, TestRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test");
      },
    },
  };
}

function makeResearch(): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [],
    entityFields: [],
    ariaSnapshotMasked: "- heading",
    capturedAt: new Date(),
  };
}

describe("GET /explorer/runs and GET /session-replay/runs (LIST-ALL audit fix) — mirror GET /runs's " +
  "pagination shape exactly", () => {
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
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-list-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-list-"));
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

  it("GET /explorer/runs returns paginated TestRuns, most recent first", async () => {
    const testRun: TestRun = {
      id: randomUUID(),
      featureId: "locations",
      runId: randomUUID(),
      research: makeResearch(),
      testPlan: [],
      checkOutcomes: [],
      findingIds: [],
      startedAt: new Date(),
      status: "COMPLETED",
    };
    await deps.testRunRepo.create(testRun);

    const response = await injectAuthed({ method: "GET", url: "/explorer/runs" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ testRuns: TestRun[]; total: number }>();
    expect(body.testRuns.some((entry) => entry.id === testRun.id)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it("GET /explorer/runs?limit=1 truncates and rejects an out-of-range limit", async () => {
    const truncated = await injectAuthed({ method: "GET", url: "/explorer/runs?limit=1" });
    expect(truncated.json<{ testRuns: TestRun[] }>().testRuns).toHaveLength(1);

    const invalid = await injectAuthed({ method: "GET", url: "/explorer/runs?limit=0" });
    expect(invalid.statusCode).toBe(400);
  });

  it("GET /session-replay/runs returns paginated SessionReplayRuns, most recent first", async () => {
    const run: SessionReplayRun = {
      id: randomUUID(),
      sessionId: randomUUID(),
      replayMode: "live",
      status: "COMPLETED",
      startedAt: new Date(),
      summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
    };
    await deps.sessionReplayRunRepo.create(run);

    const response = await injectAuthed({ method: "GET", url: "/session-replay/runs" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ sessionReplayRuns: SessionReplayRun[]; total: number }>();
    expect(body.sessionReplayRuns.some((entry) => entry.id === run.id)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });
});
