import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
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

const BASE_URL = "https://fallback.test";

function sectionMatchResponse(): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", name: "submit_section_match", input: { matchedLabel: "Fahrzeuge", confidence: 0.75 } }],
    usage: { input_tokens: 80, output_tokens: 15 },
  };
}

function testPlanResponse(): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", name: "submit_test_plan", input: { hypotheses: [] } }],
    usage: { input_tokens: 40, output_tokens: 5 },
  };
}

function mockAnthropicClient(): AnthropicLike {
  return {
    messages: {
      create: (parameters) => {
        const toolName = parameters.tool_choice?.name;
        if (toolName === "submit_section_match") return Promise.resolve(sectionMatchResponse());
        return Promise.resolve(testPlanResponse());
      },
    },
  };
}

interface ExplorerRunResponseBody {
  runId: string;
  status: string;
}

async function waitUntilTerminal(
  app: FastifyInstance,
  runId: string,
  sessionCookie: string,
): Promise<{ status: string; llmCallsUsed: number; costUsd: number }> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await app.inject({ method: "GET", url: `/explorer/runs/${runId}`, headers: { cookie: sessionCookie } });
    const body = response.json<{ status: string; llmCallsUsed: number; costUsd: number }>();
    if (body.status === "COMPLETED" || body.status === "FAILED") return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe("Section-match LLM fallback wiring (explorer-spec §12.1) — a triggered fallback call is counted, " +
  "not lost before the tracked client existed", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let sessionCookie: string;
  let deps: AppDeps;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-fallback-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-fallback-"));
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
      judgeClientFactory: mockAnthropicClient,
      allowedDomains: ["fallback.test"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "test-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax",
      installRoutes: async (context) => {
        await context.route(`${BASE_URL}/**`, async (route) => {
          const { pathname } = new URL(route.request().url());
          if (pathname === "/") {
            await route.fulfill({
              contentType: "text/html",
              body: `<html><body><h1>Home</h1><ul><li onclick="window.location.href='${BASE_URL}/section'">Fahrzeuge</li></ul></body></html>`,
            });
            return;
          }
          await route.fulfill({ contentType: "text/html", body: "<html><body><h1>Fahrzeuge</h1></body></html>" });
        });
      },
    };
    app = buildApp(deps);

    const loginResponse = await app.inject({ method: "POST", url: "/auth/login", payload: { password: deps.dashboardPassword } });
    sessionCookie = loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("a word-level miss ('the vehicles list and detail view' vs the real label 'Fahrzeuge') escalates to the " +
    "LLM fallback, resolves the section, and the fallback call's usage lands in the run's llmCallsUsed/costUsd " +
    "— proving trackClientUsage now wraps the client before locateSection runs, not after", async () => {
    const postResponse = await app.inject({
      method: "POST",
      url: "/explorer/runs",
      headers: { cookie: sessionCookie },
      payload: {
        featureId: "vehicles",
        sectionDescription: "the vehicles list and detail view",
        targetBaseUrl: `${BASE_URL}/`,
      },
    });
    expect(postResponse.statusCode).toBe(202);
    const { runId } = postResponse.json<ExplorerRunResponseBody>();

    const after = await waitUntilTerminal(app, runId, sessionCookie);

    expect(after.status).toBe("COMPLETED");
    expect(after.llmCallsUsed).toBe(2);
    const expectedCost = (80 * 3 + 15 * 15) / 1_000_000 + (40 * 3 + 5 * 15) / 1_000_000;
    expect(after.costUsd).toBeCloseTo(expectedCost, 10);
  }, 15_000);
});
