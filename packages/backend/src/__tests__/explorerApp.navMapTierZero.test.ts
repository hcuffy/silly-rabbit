import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { randomUUID } from "node:crypto";
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
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { NavMapRepo } from "../repos/navMapRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const BASE_URL = "https://nav-map-tier-zero.test";

function testPlanResponse(): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", name: "submit_test_plan", input: { hypotheses: [] } }],
    usage: { input_tokens: 40, output_tokens: 5 },
  };
}

function mockAnthropicClientRejectingSectionMatch(): AnthropicLike {
  return {
    messages: {
      create: (parameters) => {
        if (parameters.tool_choice?.name === "submit_section_match") {
          throw new Error("section-match LLM fallback should not be called — a NavMap tier-0 hit must resolve this run");
        }
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
): Promise<{ status: string; llmCallsUsed: number; error?: string }> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await app.inject({ method: "GET", url: `/explorer/runs/${runId}`, headers: { cookie: sessionCookie } });
    const body = response.json<{ status: string; llmCallsUsed: number; error?: string }>();
    if (body.status === "COMPLETED" || body.status === "FAILED") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe(
  "NavMap tier-0 wiring end-to-end (app-mapping-spec.md §7) — a real crawled NavMap in Mongo lets a " +
    "real explorer run skip the section-match LLM fallback entirely",
  () => {
    let mongod: MongoMemoryServer;
    let connection: MongoConnection;
    let app: FastifyInstance;
    let sessionCookie: string;
    let deps: AppDeps;
    let navMapRepo: NavMapRepo;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await connectMongo(mongod.getUri());
      const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-navmap-tier0-"));
      const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-navmap-tier0-"));
      navMapRepo = new NavMapRepo(connection.db);
      await navMapRepo.ensureIndexes();

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
        navMapRepo,
        reproSpecDirectory,
        screenshotDirectory,
        screenshotStorageCapBytes: 1_000_000_000,
        judgeClientFactory: mockAnthropicClientRejectingSectionMatch,
        allowedDomains: ["nav-map-tier-zero.test"],
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

    it(
      "a real NavMap entry for the target lets locateSection resolve via tier-0, so the run completes without " +
        "ever calling the section-match LLM (which would throw and fail the run if it were reached)",
      async () => {
        await navMapRepo.upsert({
          id: randomUUID(),
          baseUrl: `${BASE_URL}/`,
          entries: [{ role: "listitem", label: "Fahrzeuge", discoveredAt: new Date(), isStale: false }],
          crawledAt: new Date(),
          crawlDurationMs: 0,
        });

        const postResponse = await app.inject({
          method: "POST",
          url: "/explorer/runs",
          headers: { cookie: sessionCookie },
          payload: { featureId: "vehicles", sectionDescription: "Fahrzeuge", targetBaseUrl: `${BASE_URL}/` },
        });
        expect(postResponse.statusCode).toBe(202);
        const { runId } = postResponse.json<ExplorerRunResponseBody>();

        const after = await waitUntilTerminal(app, runId, sessionCookie);

        expect(after.status).toBe("COMPLETED");
        expect(after.llmCallsUsed).toBe(1);
      },
      15_000,
    );
  },
);
