import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
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

const BASE_URL = "https://example.test";

function testPlanResponse(): AnthropicMessageResponse {
  return {
    content: [
      {
        type: "tool_use",
        name: "submit_test_plan",
        input: {
          hypotheses: [
            {
              assumption: "the Save button responds",
              happyPathCheck: { description: "Click Save", action: "click", expectedOutcome: "handled", targetElement: "Save" },
              boundaryCheck: {
                description: "Submit an empty required field",
                action: "submit",
                inputValues: { NonExistentField: "x" },
                expectedOutcome: "a validation error is shown",
                category: "empty_required",
              },
            },
          ],
        },
      },
    ],
    usage: { input_tokens: 200, output_tokens: 100 },
  };
}

function outcomeResponse(): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", name: "submit_check_outcome", input: { passed: true, reasoning: "ok", confidence: 0.9 } }],
    usage: { input_tokens: 150, output_tokens: 30 },
  };
}

function mockAnthropicClient(): AnthropicLike {
  return {
    messages: {
      create: (parameters) => Promise.resolve(parameters.tool_choice?.name === "submit_test_plan" ? testPlanResponse() : outcomeResponse()),
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
    const response = await app.inject({
      method: "GET",
      url: `/explorer/runs/${runId}`,
      headers: { cookie: sessionCookie },
    });
    const body = response.json<{ status: string; llmCallsUsed: number; costUsd: number }>();
    if (body.status === "COMPLETED" || body.status === "FAILED") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe("Cost tracking — Run.llmCallsUsed / costUsd actually wired for D8 (previously always 0)", () => {
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
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-cost-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-cost-"));
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
      allowedDomains: ["example.test"],
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
              body: `<html><body><h1>Home</h1><a href="/section">Go To Section</a></body></html>`,
            });
            return;
          }
          await route.fulfill({
            contentType: "text/html",
            body: `<html><body><h1>Locations</h1><button type="button">Save</button></body></html>`,
          });
        });
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

  it(
    "BEFORE: a fresh Run starts at llmCallsUsed:0, costUsd:0 — AFTER: a completed run whose test-plan and " +
      "happy-path check both made real (mocked) Anthropic calls shows nonzero values matching the real call count",
    async () => {
      const postResponse = await injectAuthed({
        method: "POST",
        url: "/explorer/runs",
        payload: { featureId: "locations", sectionDescription: "Go To Section", targetBaseUrl: `${BASE_URL}/` },
      });
      expect(postResponse.statusCode).toBe(202);
      const { runId } = postResponse.json<ExplorerRunResponseBody>();

      const beforeResponse = await injectAuthed({ method: "GET", url: `/explorer/runs/${runId}` });
      const before = beforeResponse.json<{ llmCallsUsed: number; costUsd: number }>();
      expect(before.llmCallsUsed).toBe(0);
      expect(before.costUsd).toBe(0);

      const after = await waitUntilTerminal(app, runId, sessionCookie);
      expect(after.status).toBe("COMPLETED");

      expect(after.llmCallsUsed).toBe(2);
      expect(after.costUsd).toBeGreaterThan(0);

      const expectedCost =
        (200 * 3 + 100 * 15) / 1_000_000 + // test-plan call: 200 input / 100 output tokens, Sonnet pricing
        (150 * 3 + 30 * 15) / 1_000_000; // outcome-judge call: 150 input / 30 output tokens, Sonnet pricing
      expect(after.costUsd).toBeCloseTo(expectedCost, 10);
    },
    15_000,
  );
});
