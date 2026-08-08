import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Finding, Run } from "@silly-rabbit/shared";
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
        throw new Error("judge should not be called in findings-stats route tests");
      },
    },
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    charter: "test the locations flow",
    targetBaseUrl: "http://mock.local",
    status: "COMPLETED",
    startedAt: new Date(),
    stepsUsed: 1,
    llmCallsUsed: 0,
    costUsd: 0,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  const now = new Date();
  return {
    id: randomUUID(),
    runId: "run-1",
    screenId: "screen-1",
    type: "STATE_DIVERGENCE",
    evidence: {},
    dedupKey: `dedup-${randomUUID()}`,
    status: "NEW",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("GET /findings/stats (dashboard-analytics-spec Phase 2)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let deps: AppDeps;
  let sessionCookie: string;

  function injectAuthed(options: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...options, headers: { ...options.headers, cookie: sessionCookie } });
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-findings-stats-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-findings-stats-"));
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

  it("is rejected without a session cookie (lands inside the global preHandler, not exempted)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/findings/stats?targetBaseUrl=${encodeURIComponent("http://mock.local")}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("400s on a missing or invalid targetBaseUrl", async () => {
    const missing = await injectAuthed({ method: "GET", url: "/findings/stats" });
    expect(missing.statusCode).toBe(400);

    const invalid = await injectAuthed({ method: "GET", url: "/findings/stats?targetBaseUrl=not-a-url" });
    expect(invalid.statusCode).toBe(400);
  });

  it("does not collide with GET /findings/:id — returns the stats shape, not a 404 for a finding with id 'stats'", async () => {
    const response = await injectAuthed({
      method: "GET",
      url: `/findings/stats?targetBaseUrl=${encodeURIComponent(`http://empty-${randomUUID()}.local`)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ newCount: 0, suppressedCount: 0, agree: 0, disagree: 0 });
  });

  it("aggregates new/suppressed and judge-accuracy counts across all runs for a target, excluding other targets", async () => {
    const targetA = `http://target-a-${randomUUID()}.local`;
    const targetB = `http://target-b-${randomUUID()}.local`;

    const runA1 = makeRun({ targetBaseUrl: targetA });
    const runA2 = makeRun({ targetBaseUrl: targetA });
    const runB = makeRun({ targetBaseUrl: targetB });
    await Promise.all([deps.runRepo.create(runA1), deps.runRepo.create(runA2), deps.runRepo.create(runB)]);

    await deps.findingRepo.upsert(makeFinding({ runId: runA1.id, status: "NEW" }));
    await deps.findingRepo.upsert(makeFinding({ runId: runA1.id, status: "RECURRING" }));
    await deps.findingRepo.upsert(
      makeFinding({
        runId: runA2.id,
        type: "BEHAVIOR_CHECK_FAILED",
        featureId: "locations",
        verdict: "REGRESSION",
        humanVerdict: "confirmed_issue",
        status: "NEW",
      }),
    );
    await deps.findingRepo.upsert(makeFinding({ runId: runB.id, status: "NEW" }));

    const response = await injectAuthed({
      method: "GET",
      url: `/findings/stats?targetBaseUrl=${encodeURIComponent(targetA)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ newCount: 2, suppressedCount: 1, agree: 1, disagree: 0 });
  });
});
