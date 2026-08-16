import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Finding, SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { deleteSessionRecordingCascade } from "../cascadeDelete.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";
import { startSessionReplayRun } from "../sessionReplayRunLifecycle.js";

const MOCK_BASE_URL = "http://mock.local";

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
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

describe("session-replay zombie-orphan fix + SessionRecording cascade batching (performance-audit fixes)", () => {
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
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-zombie-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-zombie-"));
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

  it(
    "DELETE /session-replay/runs/:id on a RUNNING run cancels the job to full completion before " +
      "cascading — the doomed step's error Finding gets created and correctly counted/deleted by the " +
      "cascade, not orphaned after it (performance-audit zombie-orphan fix)",
    async () => {
      const recording: SessionRecording = {
        sessionId: randomUUID(),
        targetBaseUrl: MOCK_BASE_URL,
        recordedAt: new Date(),
        steps: [{ action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 }],
      };
      await deps.sessionRecordingRepo.create(recording);

      const run = await startSessionReplayRun(
        { sessionId: recording.sessionId },
        {
          ...deps,
          installRoutes: async (context) => {
            await context.route("**/*", () => new Promise(() => {}));
          },
        },
      );
      if (!run) {
        throw new Error("unreachable");
      }
      await waitUntil(async () => (await deps.sessionReplayRunRepo.get(run.id))?.status === "RUNNING");
      await new Promise((resolve) => setTimeout(resolve, 400));

      const originalUpsert = deps.findingRepo.upsert.bind(deps.findingRepo);
      const upsertSpy = vi.spyOn(deps.findingRepo, "upsert").mockImplementation(async (finding) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await originalUpsert(finding);
      });

      const deleteResponse = await injectAuthed({ method: "DELETE", url: `/session-replay/runs/${run.id}` });
      upsertSpy.mockRestore();
      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json<{ deletedFindings: number }>().deletedFindings).toBe(1);

      expect(await deps.sessionReplayRunRepo.get(run.id)).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await deps.findingRepo.findByRunIds([run.id])).toEqual([]);
    },
    20_000,
  );

  it(
    "SessionRecording cascade: batched to a fixed number of Mongo round-trips regardless of N " +
      "replay runs — was 3N+2 (11 for N=3), now 5 total (performance-audit batching fix, measured via " +
      "real repo-method call counts, not just end-state)",
    async () => {
      const recording: SessionRecording = {
        sessionId: randomUUID(),
        targetBaseUrl: MOCK_BASE_URL,
        recordedAt: new Date(),
        steps: [],
      };
      await deps.sessionRecordingRepo.create(recording);

      const runIds = [randomUUID(), randomUUID(), randomUUID()];
      for (const runId of runIds) {
        await deps.sessionReplayRunRepo.create({
          id: runId,
          sessionId: recording.sessionId,
          replayMode: "live",
          status: "COMPLETED",
          startedAt: new Date(),
          completedAt: new Date(),
          summary: { stepsExecuted: 0, stepsDrifted: 0, stepsErrored: 0 },
        });
        await deps.findingRepo.upsert(makeFinding({ runId }));
      }

      const findByRunIdsSpy = vi.spyOn(deps.findingRepo, "findByRunIds");
      const deleteByRunIdsSpy = vi.spyOn(deps.findingRepo, "deleteByRunIds");
      const findBySessionIdSpy = vi.spyOn(deps.sessionReplayRunRepo, "findBySessionId");
      const deleteByIdsSpy = vi.spyOn(deps.sessionReplayRunRepo, "deleteByIds");
      const singularDeleteSpy = vi.spyOn(deps.sessionReplayRunRepo, "delete");

      const result = await deleteSessionRecordingCascade(recording.sessionId, deps);

      expect(result).toEqual({ deletedSessionReplayRuns: 3, deletedFindings: 3 });
      expect(findBySessionIdSpy).toHaveBeenCalledTimes(1);
      expect(findByRunIdsSpy).toHaveBeenCalledTimes(1);
      expect(deleteByRunIdsSpy).toHaveBeenCalledTimes(1);
      expect(deleteByIdsSpy).toHaveBeenCalledTimes(1);
      expect(singularDeleteSpy).not.toHaveBeenCalled(); // old code called this once per replay run (N times)

      findByRunIdsSpy.mockRestore();
      deleteByRunIdsSpy.mockRestore();
      findBySessionIdSpy.mockRestore();
      deleteByIdsSpy.mockRestore();
      singularDeleteSpy.mockRestore();

      expect(await deps.sessionRecordingRepo.get(recording.sessionId)).toBeNull();
      expect(await deps.findingRepo.findByRunIds(runIds)).toEqual([]);
    },
    20_000,
  );
});
