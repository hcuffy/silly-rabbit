import type { AnthropicLike } from "@silly-rabbit/engine";
import type { SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
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

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

describe(
  "DELETE /session-recordings/:id auto-cancels a RUNNING nested SessionReplayRun before " +
    "batch-cascading (composed interaction: zombie-orphan fix + batched recording cascade)",
  () => {
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
      const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-recdel-nested-"));
      const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-recdel-nested-"));
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
      "DELETE /session-recordings/:id on a recording with one RUNNING nested SessionReplayRun " +
        "stops the real chromium instance, catches the doomed step's Finding in the cascade (not " +
        "orphaned afterward), and cleanly removes the recording + run + finding",
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

        const deleteResponse = await injectAuthed({ method: "DELETE", url: `/session-recordings/${recording.sessionId}` });
        upsertSpy.mockRestore();

        expect(deleteResponse.statusCode).toBe(200);
        expect(deleteResponse.json<{ deletedSessionReplayRuns: number; deletedFindings: number }>()).toEqual({
          deletedSessionReplayRuns: 1,
          deletedFindings: 1,
        });

        expect(await deps.sessionRecordingRepo.get(recording.sessionId)).toBeNull();
        expect(await deps.sessionReplayRunRepo.get(run.id)).toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await deps.findingRepo.findByRunIds([run.id])).toEqual([]);
      },
      20_000,
    );
  },
);
