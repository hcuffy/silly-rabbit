import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { Learning, ResearchInventory, TestRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { describe, expect, it } from "vitest";
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

function textJudgeClient(text = "# Locations\n\nGenerated doc content."): AnthropicLike {
  const response: AnthropicMessageResponse = {
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  return { messages: { create: () => Promise.resolve(response) } };
}

function makeResearch(overrides: Partial<ResearchInventory> = {}): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [{ kind: "input", accessibleName: "Search", role: "textbox" }],
    entityFields: ["Name"],
    ariaSnapshotMasked: "- table",
    capturedAt: new Date(),
    ...overrides,
  };
}

function makeTestRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: randomUUID(),
    featureId: "locations",
    runId: "run-1",
    research: makeResearch(),
    testPlan: [],
    checkOutcomes: [],
    findingIds: [],
    startedAt: new Date(),
    finishedAt: new Date(),
    status: "COMPLETED",
    ...overrides,
  };
}

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  const now = new Date();
  return {
    id: randomUUID(),
    featureId: "locations",
    learningType: "confirmed_issue",
    description: "the name field silently accepts an empty value",
    source: "run_verdict",
    firstSeenRunId: "run-1",
    lastConfirmedRunId: "run-1",
    status: "active",
    dedupKey: "dedup-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function withTestApp(
  judgeClientFactory: () => AnthropicLike,
  run: (app: FastifyInstance, deps: AppDeps, sessionCookie: string) => Promise<void>,
): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  const connection: MongoConnection = await connectMongo(mongod.getUri());
  try {
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-featuredocs-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-featuredocs-"));
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
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "correct-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax",
    };
    const app = buildApp(deps);
    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { password: deps.dashboardPassword },
      });
      const sessionCookie = loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      await run(app, deps, sessionCookie);
    } finally {
      await app.close();
    }
  } finally {
    await closeMongo(connection);
    await mongod.stop();
  }
}

describe("Feature docs (feature-docs-spec) — self-writing per-feature docs", () => {
  it("POST /features/:featureId/docs 404s when no TestRun/research exists yet for that featureId", async () => {
    await withTestApp(textJudgeClient, async (app, _deps, sessionCookie) => {
      const response = await app.inject({
        method: "POST",
        url: "/features/no-such-feature/docs",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it("generates a real doc from the latest TestRun's research + active learnings, persists it, returns 200", async () => {
    await withTestApp(textJudgeClient, async (app, deps, sessionCookie) => {
      const testRun = makeTestRun();
      await deps.testRunRepo.create(testRun);
      const learning = makeLearning();
      await deps.learningRepo.upsert(learning);

      const response = await app.inject({
        method: "POST",
        url: `/features/${testRun.featureId}/docs`,
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        id: string;
        content: string;
        model: string;
        sourceTestRunId: string;
        activeLearningIds: string[];
      }>();
      expect(body.content).toBe("# Locations\n\nGenerated doc content.");
      expect(body.model).toBe("claude-sonnet-4-6");
      expect(body.sourceTestRunId).toBe(testRun.id);
      expect(body.activeLearningIds).toEqual([learning.id]);

      const persisted = await deps.featureDocumentRepo.findLatestByFeatureId(testRun.featureId);
      expect(persisted?.id).toBe(body.id);
    });
  });

  it("a second immediate generation for the same featureId is refused with 429 (10-minute cooldown)", async () => {
    await withTestApp(textJudgeClient, async (app, deps, sessionCookie) => {
      const testRun = makeTestRun();
      await deps.testRunRepo.create(testRun);

      const first = await app.inject({
        method: "POST",
        url: `/features/${testRun.featureId}/docs`,
        headers: { cookie: sessionCookie },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `/features/${testRun.featureId}/docs`,
        headers: { cookie: sessionCookie },
      });
      expect(second.statusCode).toBe(429);
      expect(second.json<{ retryAfterMs: number }>().retryAfterMs).toBeGreaterThan(0);
    });
  });

  it("GET /features/:featureId/docs returns full append-only history, newest first", async () => {
    await withTestApp(textJudgeClient, async (app, deps, sessionCookie) => {
      const testRun = makeTestRun();
      await deps.testRunRepo.create(testRun);

      const olderDocument = await app.inject({
        method: "POST",
        url: `/features/${testRun.featureId}/docs`,
        headers: { cookie: sessionCookie },
      });
      const olderId = olderDocument.json<{ id: string }>().id;

      await deps.featureDocumentRepo.create({
        id: randomUUID(),
        featureId: testRun.featureId,
        generatedAt: new Date(Date.now() + 60_000),
        sourceTestRunId: testRun.id,
        activeLearningIds: [],
        content: "newer content",
        model: "claude-sonnet-4-6",
        llmCallsUsed: 1,
        costUsd: 0.01,
      });

      const historyResponse = await app.inject({
        method: "GET",
        url: `/features/${testRun.featureId}/docs`,
        headers: { cookie: sessionCookie },
      });
      expect(historyResponse.statusCode).toBe(200);
      const history = historyResponse.json<{ id: string; content: string }[]>();
      expect(history).toHaveLength(2);
      expect(history[0]?.content).toBe("newer content");
      expect(history[1]?.id).toBe(olderId);
    });
  });

  it("GET /features/:featureId/docs/latest 404s when nothing has been generated yet", async () => {
    await withTestApp(textJudgeClient, async (app, _deps, sessionCookie) => {
      const response = await app.inject({
        method: "GET",
        url: "/features/no-such-feature/docs/latest",
        headers: { cookie: sessionCookie },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it("all three routes reject requests without a session cookie (same global auth gate as every other route)", async () => {
    await withTestApp(textJudgeClient, async (app) => {
      const post = await app.inject({ method: "POST", url: "/features/locations/docs" });
      const get = await app.inject({ method: "GET", url: "/features/locations/docs" });
      const latest = await app.inject({ method: "GET", url: "/features/locations/docs/latest" });
      expect(post.statusCode).toBe(401);
      expect(get.statusCode).toBe(401);
      expect(latest.statusCode).toBe(401);
    });
  });
});
