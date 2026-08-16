import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { PNG } from "pngjs";
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

function seedFor(overrides: Partial<MockSeed> = {}): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 7, ...overrides };
}

function solidColorPng(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const offset = pixelIndex * 4;
    png.data[offset] = red;
    png.data[offset + 1] = green;
    png.data[offset + 2] = blue;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

interface RunResponseBody {
  runId: string;
  status: string;
}

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called — no divergence expected in this test");
      },
    },
  };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

describe("Fastify app (backend-spec §5)", () => {
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
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-app-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-app-"));
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

  it("rejects an invalid POST /runs body with structured JSON, not a stack trace", async () => {
    const response = await injectAuthed({ method: "POST", url: "/runs", payload: { charter: "x" } });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string }>();
    expect(body.error).toBeTruthy();
    expect(body).not.toHaveProperty("stack");
  });

  it("POST /runs returns immediately and the run completes in the background; GET reflects the transition", async () => {
    const postResponse = await injectAuthed({
      method: "POST",
      url: "/runs",
      payload: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
    });
    expect(postResponse.statusCode).toBe(202);
    const { runId, status } = postResponse.json<RunResponseBody>();
    expect(["PENDING", "RUNNING"]).toContain(status);

    await waitUntil(async () => {
      const getResponse = await injectAuthed({ method: "GET", url: `/runs/${runId}` });
      return getResponse.json<{ status: string }>().status === "COMPLETED";
    });

    const findingsResponse = await injectAuthed({ method: "GET", url: `/runs/${runId}/findings` });
    expect(findingsResponse.statusCode).toBe(200);

    const listResponse = await injectAuthed({ method: "GET", url: "/runs" });
    const { runs, total } = listResponse.json<{ runs: { id: string }[]; total: number }>();
    expect(runs.some((run) => run.id === runId)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("GET /runs/:id 404s for an unknown run", async () => {
    const response = await injectAuthed({ method: "GET", url: `/runs/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it("GET /findings/:id/repro 404s when no repro spec exists for the finding", async () => {
    const response = await injectAuthed({ method: "GET", url: `/findings/${randomUUID()}/repro` });
    expect(response.statusCode).toBe(404);
  });

  it("GET /findings/:id/screenshot 404s when no screenshot exists for the finding", async () => {
    const response = await injectAuthed({ method: "GET", url: `/findings/${randomUUID()}/screenshot` });
    expect(response.statusCode).toBe(404);
  });

  it("GET /findings/:id/screenshot serves the stored PNG bytes with an image/png content type", async () => {
    const now = new Date();
    const findingId = randomUUID();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);
    const screenshotPath = join(deps.screenshotDirectory, `${findingId}.png`);
    await writeFile(screenshotPath, pngBytes);

    await deps.findingRepo.upsert({
      id: findingId,
      runId: "run-1",
      screenId: "screen-1",
      type: "BEHAVIOR_CHECK_FAILED",
      evidence: {},
      dedupKey: `dedup-${findingId}`,
      status: "NEW",
      screenshotPath,
      createdAt: now,
      updatedAt: now,
    });

    const response = await injectAuthed({ method: "GET", url: `/findings/${findingId}/screenshot` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload).toEqual(pngBytes);
  });

  it("GET /findings/:id/pixel-diff 404s when the finding has no before or after screenshot", async () => {
    const response = await injectAuthed({ method: "GET", url: `/findings/${randomUUID()}/pixel-diff` });
    expect(response.statusCode).toBe(404);
  });

  it("GET /findings/:id/pixel-diff computes a real score from the stored before/after PNGs, on request — nothing stored on Finding", async () => {
    const now = new Date();
    const findingId = randomUUID();
    const beforePath = join(deps.screenshotDirectory, `before-${findingId}.png`);
    const afterPath = join(deps.screenshotDirectory, `${findingId}.png`);
    await writeFile(beforePath, solidColorPng(4, 4, [0, 0, 0]));
    await writeFile(afterPath, solidColorPng(4, 4, [255, 255, 255]));

    await deps.findingRepo.upsert({
      id: findingId,
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      evidence: {},
      dedupKey: `dedup-${findingId}`,
      status: "NEW",
      beforeScreenshotPath: beforePath,
      screenshotPath: afterPath,
      createdAt: now,
      updatedAt: now,
    });

    const response = await injectAuthed({ method: "GET", url: `/findings/${findingId}/pixel-diff` });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ pixelDiffScore: number }>().pixelDiffScore).toBe(1);

    const persisted = await deps.findingRepo.get(findingId);
    expect(persisted).not.toHaveProperty("pixelDiffScore");
  });

  it("GET /findings/:id/pixel-diff 422s when the before/after screenshots have mismatched dimensions", async () => {
    const now = new Date();
    const findingId = randomUUID();
    const beforePath = join(deps.screenshotDirectory, `before-${findingId}.png`);
    const afterPath = join(deps.screenshotDirectory, `${findingId}.png`);
    await writeFile(beforePath, solidColorPng(4, 4, [0, 0, 0]));
    await writeFile(afterPath, solidColorPng(8, 8, [0, 0, 0]));

    await deps.findingRepo.upsert({
      id: findingId,
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      evidence: {},
      dedupKey: `dedup-${findingId}`,
      status: "NEW",
      beforeScreenshotPath: beforePath,
      screenshotPath: afterPath,
      createdAt: now,
      updatedAt: now,
    });

    const response = await injectAuthed({ method: "GET", url: `/findings/${findingId}/pixel-diff` });
    expect(response.statusCode).toBe(422);
  });

  describe("CORS (safety-spec §7)", () => {
    it("reflects the configured origin", async () => {
      const response = await injectAuthed({
        method: "GET",
        url: "/runs",
        headers: { origin: "http://localhost:5173" },
      });
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    });

    it("does not reflect a disallowed origin", async () => {
      const response = await injectAuthed({
        method: "GET",
        url: "/runs",
        headers: { origin: "http://evil.example" },
      });
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });
});
