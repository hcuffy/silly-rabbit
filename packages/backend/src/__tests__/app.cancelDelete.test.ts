import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
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
import { startRun } from "../orchestrator.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const MOCK_BASE_URL = "http://mock.local";

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

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    runId: "run-1",
    screenId: "screen-1",
    type: "CONSOLE_ERROR",
    evidence: {},
    dedupKey: `dedup-${randomUUID()}`,
    status: "NEW",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

describe("HTTP cancel/delete routes — /runs and /findings (delete-cancel-spec.md phase 2)", () => {
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
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-canceldelete-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-canceldelete-"));
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
    await closeMongo(connection);
    await mongod.stop();
  });

  it("POST /runs/:id/cancel on a real RUNNING run closes the real chromium instance — 200, status " +
    "sticks at CANCELLED", async () => {
    const run = await startRun(
      { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
      { ...deps, installRoutes: async (context) => { await context.route("**/*", () => new Promise(() => {})); } },
    );
    await waitUntil(async () => (await deps.runRepo.get(run.id))?.status === "RUNNING");
    await new Promise((resolve) => setTimeout(resolve, 400));

    const cancelResponse = await injectAuthed({ method: "POST", url: `/runs/${run.id}/cancel` });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toEqual({ cancelled: true });

    await waitUntil(async () => (await deps.runRepo.get(run.id))?.status === "CANCELLED");
  }, 20_000);

  it("POST /runs/:id/cancel returns 409 for an already-COMPLETED run", async () => {
    const triggerResponse = await injectAuthed({
      method: "POST",
      url: "/runs",
      payload: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
    });
    const { runId } = triggerResponse.json<{ runId: string }>();
    await waitUntil(async () => {
      const response = await injectAuthed({ method: "GET", url: `/runs/${runId}` });
      return response.json<{ status: string }>().status === "COMPLETED";
    });

    const cancelResponse = await injectAuthed({ method: "POST", url: `/runs/${runId}/cancel` });
    expect(cancelResponse.statusCode).toBe(409);
    expect(cancelResponse.json<{ error: string }>().error).toContain("COMPLETED");
  }, 20_000);

  it("POST /runs/:id/cancel returns 404 for an unknown run id", async () => {
    const response = await injectAuthed({ method: "POST", url: `/runs/${randomUUID()}/cancel` });
    expect(response.statusCode).toBe(404);
  });

  it("DELETE /runs/:id cascades to Findings via the route layer (not just the repo), returns counts, " +
    "and a subsequent GET 404s", async () => {
    const triggerResponse = await injectAuthed({
      method: "POST",
      url: "/runs",
      payload: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
    });
    const { runId } = triggerResponse.json<{ runId: string }>();
    await waitUntil(async () => {
      const response = await injectAuthed({ method: "GET", url: `/runs/${runId}` });
      return response.json<{ status: string }>().status === "COMPLETED";
    });

    const finding = makeFinding({ runId });
    await deps.findingRepo.upsert(finding);

    const deleteResponse = await injectAuthed({ method: "DELETE", url: `/runs/${runId}` });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ deletedFindings: 1, deletedTestRun: false });

    const getResponse = await injectAuthed({ method: "GET", url: `/runs/${runId}` });
    expect(getResponse.statusCode).toBe(404);
    expect(await deps.findingRepo.get(finding.id)).toBeNull();
  }, 20_000);

  it("DELETE /runs/:id returns 404 for an unknown id", async () => {
    const response = await injectAuthed({ method: "DELETE", url: `/runs/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it("DELETE /findings/:id hard-deletes — 204, distinct from POST /findings/:id/feedback's dismiss " +
    "(both routes coexist)", async () => {
    const finding = makeFinding();
    await deps.findingRepo.upsert(finding);

    const deleteResponse = await injectAuthed({ method: "DELETE", url: `/findings/${finding.id}` });
    expect(deleteResponse.statusCode).toBe(204);
    expect(await deps.findingRepo.get(finding.id)).toBeNull();

    const dismissTarget = makeFinding();
    await deps.findingRepo.upsert(dismissTarget);
    const feedbackResponse = await injectAuthed({
      method: "POST",
      url: `/findings/${dismissTarget.id}/feedback`,
      payload: { verdict: "dismiss" },
    });
    expect(feedbackResponse.statusCode).toBe(204);
    expect((await deps.findingRepo.get(dismissTarget.id))?.status).toBe("DISMISSED");
  });

  it("DELETE /findings/:id returns 404 for an unknown id", async () => {
    const response = await injectAuthed({ method: "DELETE", url: `/findings/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });
});
