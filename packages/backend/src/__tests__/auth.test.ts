import type { AnthropicLike } from "@silly-rabbit/engine";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { signSessionToken } from "../auth.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in auth-route tests");
      },
    },
  };
}

describe("dashboard auth (POST /auth/login, POST /auth/logout, GET /auth/session)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let deps: AppDeps;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-auth-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-auth-"));
    deps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      featureDocumentRepo: new FeatureDocumentRepo(connection.db),
      sessionRecordingRepo: new SessionRecordingRepo(connection.db), sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "correct-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax",
    };
    app = buildApp(deps);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("POST /auth/login with the correct password succeeds and sets a session cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "correct-password" },
    });
    expect(response.statusCode).toBe(204);
    const sessionCookie = response.cookies.find((cookie) => cookie.name === "session");
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
  });

  it("POST /auth/login with the wrong password is rejected and sets no cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "wrong-password" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.cookies.find((cookie) => cookie.name === "session")).toBeUndefined();
  });

  it("a protected route without a session cookie is rejected", async () => {
    const response = await app.inject({ method: "GET", url: "/runs" });
    expect(response.statusCode).toBe(401);
  });

  it("a protected route with a valid session cookie passes through", async () => {
    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "correct-password" },
    });
    const sessionCookie = loginResponse.cookies.find((cookie) => cookie.name === "session");
    const response = await app.inject({
      method: "GET",
      url: "/runs",
      headers: { cookie: `session=${sessionCookie?.value}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it("POST /explorer/runs (real writes) is rejected without a session cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/explorer/runs",
      payload: { featureId: "f1", sectionDescription: "section", targetBaseUrl: "http://mock.local" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("GET /findings/:id/screenshot (unmasked data) is rejected without a session cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/findings/some-id/screenshot" });
    expect(response.statusCode).toBe(401);
  });

  it("a protected route with an expired session cookie is rejected", async () => {
    const expiredToken = signSessionToken(deps.sessionSecret, Date.now() - 1000);
    const response = await app.inject({
      method: "GET",
      url: "/runs",
      headers: { cookie: `session=${expiredToken}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("GET /auth/session reflects both authenticated and unauthenticated state", async () => {
    const loggedOutResponse = await app.inject({ method: "GET", url: "/auth/session" });
    expect(loggedOutResponse.statusCode).toBe(401);

    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "correct-password" },
    });
    const sessionCookie = loginResponse.cookies.find((cookie) => cookie.name === "session");
    const loggedInResponse = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: `session=${sessionCookie?.value}` },
    });
    expect(loggedInResponse.statusCode).toBe(200);
    expect(loggedInResponse.json<{ authenticated: boolean }>().authenticated).toBe(true);
  });
});

describe("onRequest hook exemption is exact-match, not prefix (security-audit item 2 fix)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-auth-exemption-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-auth-exemption-"));
    const deps: AppDeps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      featureDocumentRepo: new FeatureDocumentRepo(connection.db),
      sessionRecordingRepo: new SessionRecordingRepo(connection.db), sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "correct-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax",
    };
    app = buildApp(deps);
    app.get("/auth/login-history", () => ({ ok: true }));
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("a route whose path merely starts with /auth/login is NOT exempted from auth (prefix-match regression guard)", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/login-history" });
    expect(response.statusCode).toBe(401);
  });

  it("the real /auth/login route is still exempted", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "correct-password" },
    });
    expect(response.statusCode).toBe(204);
  });
});

describe("POST /auth/login rate limiting — isolated app instance so prior tests' attempts don't count", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-auth-ratelimit-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-auth-ratelimit-"));
    const deps: AppDeps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      featureDocumentRepo: new FeatureDocumentRepo(connection.db),
      sessionRecordingRepo: new SessionRecordingRepo(connection.db), sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "correct-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax",
    };
    app = buildApp(deps);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("the 6th rapid login attempt is rate-limited before reaching the password check", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
    }
    const sixthAttempt = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: "wrong-password" },
    });
    expect(sixthAttempt.statusCode).toBe(429);
  });
});
