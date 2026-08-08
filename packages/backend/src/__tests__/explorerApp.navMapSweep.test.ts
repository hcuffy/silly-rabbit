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

const DRIFT_BASE_URL = "https://sweep-drift.test";
const VERIFIED_BASE_URL = "https://sweep-verified.test";
const NONBLOCKING_BASE_URL = "https://sweep-nonblocking.test";

class ThrowingNavMapRepo extends NavMapRepo {
  callCount = 0;

  override updateEntryVerification(): Promise<void> {
    this.callCount += 1;
    return Promise.reject(new Error("simulated sweep persistence failure"));
  }
}

function testPlanResponse(): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", name: "submit_test_plan", input: { hypotheses: [] } }],
    usage: { input_tokens: 40, output_tokens: 5 },
  };
}

function mockClientRejectingSectionMatch(): AnthropicLike {
  return {
    messages: {
      create: (parameters) => {
        if (parameters.tool_choice?.name === "submit_section_match") {
          throw new Error("section-match LLM fallback should not be called for this scenario");
        }
        return Promise.resolve(testPlanResponse());
      },
    },
  };
}

function mockClientResolvingViaSectionMatch(matchedLabel: string): () => AnthropicLike {
  return () => ({
    messages: {
      create: (parameters) => {
        if (parameters.tool_choice?.name === "submit_section_match") {
          return Promise.resolve({
            content: [{ type: "tool_use", name: "submit_section_match", input: { matchedLabel, confidence: 0.8 } }],
            usage: { input_tokens: 80, output_tokens: 15 },
          });
        }
        return Promise.resolve(testPlanResponse());
      },
    },
  });
}

async function installNavItemFixture(
  context: Parameters<NonNullable<AppDeps["installRoutes"]>>[0],
  baseUrl: string,
  navItemLabel: string,
): Promise<void> {
  await context.route(`${baseUrl}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") {
      const homeBody = `<html><body><h1>Home</h1><ul>` +
        `<li onclick="window.location.href='${baseUrl}/section'">${navItemLabel}</li></ul></body></html>`;
      await route.fulfill({ contentType: "text/html", body: homeBody });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: `<html><body><h1>${navItemLabel}</h1></body></html>` });
  });
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
    if (body.status === "COMPLETED" || body.status === "FAILED") return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe("Phase 3 drift persistence + piggyback sweep (app-mapping-spec.md §6/§7) — real chromium, real Mongo", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let sessionCookie: string;
  let navMapRepo: NavMapRepo;
  let throwingNavMapRepo: ThrowingNavMapRepo;
  let deps: AppDeps;
  let nonBlockingDeps: AppDeps;
  let nonBlockingApp: FastifyInstance;
  let nonBlockingSessionCookie: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    navMapRepo = new NavMapRepo(connection.db);
    await navMapRepo.ensureIndexes();
    throwingNavMapRepo = new ThrowingNavMapRepo(connection.db);

    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-navmap-sweep-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-navmap-sweep-"));
    const baseDeps = {
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
      allowedDomains: ["sweep-drift.test", "sweep-verified.test", "sweep-nonblocking.test"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "test-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax" as const,
      installRoutes: async (context: Parameters<NonNullable<AppDeps["installRoutes"]>>[0]) => {
        await installNavItemFixture(context, DRIFT_BASE_URL, "Autos");
        await installNavItemFixture(context, VERIFIED_BASE_URL, "Fahrzeuge");
        await installNavItemFixture(context, NONBLOCKING_BASE_URL, "Fahrzeuge");
      },
    };

    deps = { ...baseDeps, navMapRepo, judgeClientFactory: mockClientResolvingViaSectionMatch("Autos") };
    app = buildApp(deps);
    const loginResponse = await app.inject({ method: "POST", url: "/auth/login", payload: { password: deps.dashboardPassword } });
    sessionCookie = loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

    nonBlockingDeps = { ...baseDeps, navMapRepo: throwingNavMapRepo, judgeClientFactory: mockClientRejectingSectionMatch };
    nonBlockingApp = buildApp(nonBlockingDeps);
    const nonBlockingLogin = await nonBlockingApp.inject({
      method: "POST",
      url: "/auth/login",
      payload: { password: nonBlockingDeps.dashboardPassword },
    });
    nonBlockingSessionCookie = nonBlockingLogin.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await nonBlockingApp.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("nav-label drift: a stored entry that no longer resolves live gets isStale persisted, run still completes via fallback", async () => {
    await navMapRepo.upsert({
      id: randomUUID(),
      baseUrl: `${DRIFT_BASE_URL}/`,
      entries: [{ role: "listitem", label: "Fahrzeuge", discoveredAt: new Date(), isStale: false }],
      crawledAt: new Date(),
      crawlDurationMs: 0,
    });

    const postResponse = await app.inject({
      method: "POST",
      url: "/explorer/runs",
      headers: { cookie: sessionCookie },
      payload: { featureId: "vehicles", sectionDescription: "Fahrzeuge", targetBaseUrl: `${DRIFT_BASE_URL}/` },
    });
    expect(postResponse.statusCode).toBe(202);
    const { runId } = postResponse.json<ExplorerRunResponseBody>();

    const after = await waitUntilTerminal(app, runId, sessionCookie);
    expect(after.status).toBe("COMPLETED");

    const navMap = await navMapRepo.getByBaseUrl(`${DRIFT_BASE_URL}/`);
    const entry = navMap?.entries.find((candidate) => candidate.label === "Fahrzeuge");
    expect(entry?.isStale).toBe(true);
  }, 15_000);

  it("verified entry: a tier-0 hit persists lastVerifiedAt and keeps isStale false", async () => {
    await navMapRepo.upsert({
      id: randomUUID(),
      baseUrl: `${VERIFIED_BASE_URL}/`,
      entries: [{ role: "listitem", label: "Fahrzeuge", discoveredAt: new Date(), isStale: false }],
      crawledAt: new Date(),
      crawlDurationMs: 0,
    });

    const postResponse = await app.inject({
      method: "POST",
      url: "/explorer/runs",
      headers: { cookie: sessionCookie },
      payload: { featureId: "vehicles", sectionDescription: "Fahrzeuge", targetBaseUrl: `${VERIFIED_BASE_URL}/` },
    });
    const { runId } = postResponse.json<ExplorerRunResponseBody>();

    const after = await waitUntilTerminal(app, runId, sessionCookie);
    expect(after.status).toBe("COMPLETED");
    expect(after.llmCallsUsed).toBe(1); // tier-0 hit — section-match LLM never called

    const navMap = await navMapRepo.getByBaseUrl(`${VERIFIED_BASE_URL}/`);
    const entry = navMap?.entries.find((candidate) => candidate.label === "Fahrzeuge");
    expect(entry?.isStale).toBe(false);
    expect(entry?.lastVerifiedAt).toBeDefined();
    expect(entry!.lastVerifiedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  }, 15_000);

  it("sweep never blocks or fails the triggering run: a persistence failure in the sweep is swallowed, run still completes", async () => {
    await throwingNavMapRepo.upsert({
      id: randomUUID(),
      baseUrl: `${NONBLOCKING_BASE_URL}/`,
      entries: [
        { role: "link", label: "UnrelatedFoo", discoveredAt: new Date(), isStale: false },
        { role: "link", label: "UnrelatedBar", discoveredAt: new Date(), isStale: false },
      ],
      crawledAt: new Date(),
      crawlDurationMs: 0,
    });

    const postResponse = await nonBlockingApp.inject({
      method: "POST",
      url: "/explorer/runs",
      headers: { cookie: nonBlockingSessionCookie },
      payload: { featureId: "vehicles", sectionDescription: "Fahrzeuge", targetBaseUrl: `${NONBLOCKING_BASE_URL}/` },
    });
    expect(postResponse.statusCode).toBe(202);
    const { runId } = postResponse.json<ExplorerRunResponseBody>();

    const after = await waitUntilTerminal(nonBlockingApp, runId, nonBlockingSessionCookie);

    expect(after.status).toBe("COMPLETED");
    expect(after.llmCallsUsed).toBe(1); // resolved via tier-1 word-match, no section-match LLM needed
    expect(throwingNavMapRepo.callCount).toBeGreaterThan(0);
  }, 15_000);
});
