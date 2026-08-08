import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Finding } from "@silly-rabbit/shared";
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
        throw new Error("judge should not be called in feedback-route tests");
      },
    },
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  const now = new Date();
  return {
    id: randomUUID(),
    runId: `run-${randomUUID()}`,
    screenId: "screen-1",
    type: "BEHAVIOR_CHECK_FAILED",
    verdict: "REGRESSION",
    reasoning: "the name field silently accepts an empty value",
    evidence: {},
    dedupKey: `dedup-${randomUUID()}`,
    status: "NEW",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("POST /findings/:id/feedback (D8 dashboard triage — dismiss-gap fix)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let sessionCookie: string;

  function injectAuthed(options: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...options, headers: { ...options.headers, cookie: sessionCookie } });
  }
  let deps: AppDeps;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-feedback-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-feedback-"));
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

  it("404s for an unknown finding id", async () => {
    const response = await injectAuthed({
      method: "POST",
      url: `/findings/${randomUUID()}/feedback`,
      payload: { verdict: "dismiss" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s for an invalid verdict", async () => {
    const finding = makeFinding();
    await deps.findingRepo.upsert(finding);
    const response = await injectAuthed({
      method: "POST",
      url: `/findings/${finding.id}/feedback`,
      payload: { verdict: "not_a_real_verdict" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string }>();
    expect(body.error).toBeTruthy();
  });

  it("dismiss is allowed on a finding with no featureId (D1-D7-shaped finding)", async () => {
    const finding = makeFinding({ featureId: undefined });
    await deps.findingRepo.upsert(finding);

    const response = await injectAuthed({
      method: "POST",
      url: `/findings/${finding.id}/feedback`,
      payload: { verdict: "dismiss" },
    });
    expect(response.statusCode).toBe(204);

    const after = await deps.findingRepo.get(finding.id);
    expect(after?.status).toBe("DISMISSED");
  });

  it("confirmed_issue/intended_behavior 400 clearly when the finding has no featureId (D1-D7-shaped finding)", async () => {
    const finding = makeFinding({ featureId: undefined });
    await deps.findingRepo.upsert(finding);

    const confirmedResponse = await injectAuthed({
      method: "POST",
      url: `/findings/${finding.id}/feedback`,
      payload: { verdict: "confirmed_issue" },
    });
    expect(confirmedResponse.statusCode).toBe(400);
    expect(confirmedResponse.json<{ error: string }>().error).toMatch(/featureId/);

    const intendedResponse = await injectAuthed({
      method: "POST",
      url: `/findings/${finding.id}/feedback`,
      payload: { verdict: "intended_behavior" },
    });
    expect(intendedResponse.statusCode).toBe(400);
    expect(intendedResponse.json<{ error: string }>().error).toMatch(/featureId/);

    const after = await deps.findingRepo.get(finding.id);
    expect(after?.status).toBe("NEW");
  });

  it("confirmed_issue succeeds and records a Learning when the finding has a featureId (D8-shaped finding)", async () => {
    const finding = makeFinding({ featureId: "locations" });
    await deps.findingRepo.upsert(finding);

    const response = await injectAuthed({
      method: "POST",
      url: `/findings/${finding.id}/feedback`,
      payload: { verdict: "confirmed_issue" },
    });
    expect(response.statusCode).toBe(204);

    const learnings = await deps.learningRepo.findActiveByFeatureId("locations");
    expect(learnings).toHaveLength(1);
    expect(learnings[0]).toMatchObject({ featureId: "locations", learningType: "confirmed_issue", dedupKey: finding.dedupKey });

    const after = await deps.findingRepo.get(finding.id);
    expect(after?.humanVerdict).toBe("confirmed_issue");
  });
});
