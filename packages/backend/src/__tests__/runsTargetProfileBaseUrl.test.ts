import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import type { TargetProfile } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { ActiveTargetProfileRepo } from "../repos/activeTargetProfileRepo.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TargetProfileRepo } from "../repos/targetProfileRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const MOCK_BASE_URL = "http://mock.local";
const CREDENTIAL_ENCRYPTION_KEY = "e".repeat(64);

function seedFor(): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 1 };
}

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test — no divergence expected");
      },
    },
  };
}

function makeProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    id: randomUUID(),
    name: "Profile-default-baseUrl",
    baseUrl: MOCK_BASE_URL,
    allowedDomains: ["mock.local"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("targetBaseUrl defaults from the active target profile (target-profiles-spec.md phase 3, item 1) " +
  "— real chromium, real Mongo", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let sessionCookie: string;
  let targetProfileRepo: TargetProfileRepo;
  let activeTargetProfileRepo: ActiveTargetProfileRepo;

  function injectAuthed(options: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...options, headers: { ...options.headers, cookie: sessionCookie } });
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-profile-baseurl-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-profile-baseurl-"));
    targetProfileRepo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    activeTargetProfileRepo = new ActiveTargetProfileRepo(connection.db);

    const deps: AppDeps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      featureDocumentRepo: new FeatureDocumentRepo(connection.db),
      sessionRecordingRepo: new SessionRecordingRepo(connection.db),
      sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      targetProfileRepo,
      activeTargetProfileRepo,
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
      installRoutes: (context) => installMockTarget(context, "baseline", seedFor()),
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
    await activeTargetProfileRepo.clear();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("POST /runs without targetBaseUrl and no active profile: 400, clear error", async () => {
    const response = await injectAuthed({ method: "POST", url: "/runs", payload: { charter: "test the locations flow" } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("targetBaseUrl");
  });

  it("POST /runs without targetBaseUrl, active profile provides it as a default", async () => {
    const profile = makeProfile({ id: randomUUID() });
    await targetProfileRepo.create(profile);
    await activeTargetProfileRepo.set(profile.id);

    const response = await injectAuthed({ method: "POST", url: "/runs", payload: { charter: "test the locations flow" } });
    expect(response.statusCode).toBe(202);

    const { runId } = response.json<{ runId: string }>();
    const run = await connection.db.collection<{ _id: string; targetBaseUrl: string }>("runs").findOne({ _id: runId });
    expect(run?.targetBaseUrl).toBe(MOCK_BASE_URL);

    await activeTargetProfileRepo.clear();
  });

  it("POST /runs with an explicit targetBaseUrl: the explicit value wins over the active profile's baseUrl", async () => {
    const profile = makeProfile({ id: randomUUID(), baseUrl: "https://profile-only.example.com" });
    await targetProfileRepo.create(profile);
    await activeTargetProfileRepo.set(profile.id);

    const response = await injectAuthed({
      method: "POST",
      url: "/runs",
      payload: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
    });
    expect(response.statusCode).toBe(202);

    const { runId } = response.json<{ runId: string }>();
    const run = await connection.db.collection<{ _id: string; targetBaseUrl: string }>("runs").findOne({ _id: runId });
    expect(run?.targetBaseUrl).toBe(MOCK_BASE_URL);

    await activeTargetProfileRepo.clear();
  });

  it("POST /explorer/runs without targetBaseUrl, active profile provides it as a default", async () => {
    const profile = makeProfile({ id: randomUUID() });
    await targetProfileRepo.create(profile);
    await activeTargetProfileRepo.set(profile.id);

    const response = await injectAuthed({
      method: "POST",
      url: "/explorer/runs",
      payload: { featureId: "locations", sectionDescription: "Standorte" },
    });
    expect(response.statusCode).toBe(202);

    const { runId } = response.json<{ runId: string }>();
    const run = await connection.db.collection<{ _id: string; targetBaseUrl: string }>("runs").findOne({ _id: runId });
    expect(run?.targetBaseUrl).toBe(MOCK_BASE_URL);

    await activeTargetProfileRepo.clear();
  });

  it("POST /explorer/runs without targetBaseUrl and no active profile: 400, clear error", async () => {
    const response = await injectAuthed({
      method: "POST",
      url: "/explorer/runs",
      payload: { featureId: "locations", sectionDescription: "Standorte" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("targetBaseUrl");
  });
});
