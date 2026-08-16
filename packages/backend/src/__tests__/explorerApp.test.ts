import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import type { Run, TestRun } from "@silly-rabbit/shared";
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

const MOCK_BASE_URL = "http://mock.local";
const LIST_PATH = "/fleet/auth/platform/locations";

function seedFor(overrides: Partial<MockSeed> = {}): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 1, ...overrides };
}

function emptyTestPlanResponse(): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", name: "submit_test_plan", input: { hypotheses: [] } }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function emptyPlanJudgeClient(): AnthropicLike {
  return { messages: { create: () => Promise.resolve(emptyTestPlanResponse()) } };
}

interface ExplorerRunResponseBody {
  runId: string;
  status: string;
}

async function waitUntilTerminal(app: FastifyInstance, runId: string, sessionCookie: string): Promise<Run> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await app.inject({
      method: "GET",
      url: `/explorer/runs/${runId}`,
      headers: { cookie: sessionCookie },
    });
    const body = response.json<Run>();
    if (body.status === "COMPLETED" || body.status === "FAILED") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe("Fastify app — explorer routes (D8 HTTP wiring)", () => {
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
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-explorer-app-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-explorer-app-"));
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
      judgeClientFactory: emptyPlanJudgeClient,
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

  it("rejects an invalid POST /explorer/runs body with structured JSON, not a stack trace", async () => {
    const response = await injectAuthed({ method: "POST", url: "/explorer/runs", payload: { featureId: "locations" } });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string }>();
    expect(body.error).toBeTruthy();
    expect(body).not.toHaveProperty("stack");
  });

  it("GET /explorer/runs/:id 404s for an unknown run", async () => {
    const response = await injectAuthed({ method: "GET", url: `/explorer/runs/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it(
    "triggers, locates the section against the real mock target, and persists a TestRun + findings, " +
      "fetched via GET in the shape the frontend will need",
    async () => {
      const postResponse = await injectAuthed({
        method: "POST",
        url: "/explorer/runs",
        payload: { featureId: "locations", sectionDescription: "warehouse", targetBaseUrl: `${MOCK_BASE_URL}${LIST_PATH}` },
      });
      expect(postResponse.statusCode).toBe(202);
      const { runId, status } = postResponse.json<ExplorerRunResponseBody>();
      expect(["PENDING", "RUNNING"]).toContain(status);

      const final = await waitUntilTerminal(app, runId, sessionCookie);
      expect(final.status).toBe("COMPLETED");

      const getResponse = await injectAuthed({ method: "GET", url: `/explorer/runs/${runId}` });
      const body = getResponse.json<Run & { testRun: TestRun; findings: unknown[] }>();
      expect(body.testRun.featureId).toBe("locations");
      expect(body.testRun.runId).toBe(runId);
      expect(body.testRun.testPlan).toEqual([]);
      expect(body.findings).toEqual([]);
    },
    15_000,
  );

  it(
    "a request naming a disallowed domain is rejected before any browser action happens " + "(safety guards actually bound, not just wired-looking)",
    async () => {
      const postResponse = await injectAuthed({
        method: "POST",
        url: "/explorer/runs",
        payload: { featureId: "locations", sectionDescription: "warehouse", targetBaseUrl: "http://not-allowed.example" },
      });
      expect(postResponse.statusCode).toBe(202);
      const { runId } = postResponse.json<ExplorerRunResponseBody>();

      const final = await waitUntilTerminal(app, runId, sessionCookie);
      expect(final.status).toBe("FAILED");
      expect(final.error).toContain("not on the domain allowlist");
      expect(final.stepsUsed).toBe(0);
    },
    15_000,
  );
});
