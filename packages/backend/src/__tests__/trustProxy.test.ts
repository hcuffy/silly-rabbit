import type { AnthropicLike } from "@silly-rabbit/engine";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { closeMongo, connectMongo } from "../db/connection.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in trustProxy tests");
      },
    },
  };
}

async function withTestApp(
  trustProxy: boolean | undefined,
  run: (app: FastifyInstance, sessionCookie: string) => Promise<void>,
): Promise<void> {
  const mongod = await MongoMemoryServer.create();
  const connection = await connectMongo(mongod.getUri());
  try {
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-trustproxy-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-trustproxy-"));
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
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      corsOrigins: ["http://localhost:5173"],
      dashboardPassword: "correct-password",
      sessionSecret: "test-session-secret",
      cookieSecure: false,
      cookieSameSite: "lax",
      trustProxy,
    };
    const app = buildApp(deps);
    app.get("/__test/ip", (request) => ({ ip: request.ip }));
    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { password: deps.dashboardPassword },
      });
      const sessionCookie = loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      await run(app, sessionCookie);
    } finally {
      await app.close();
    }
  } finally {
    await closeMongo(connection);
    await mongod.stop();
  }
}

describe("trustProxy wiring (hosting-prep)", () => {
  it("defaults to false when unset — X-Forwarded-For is ignored, request.ip is the raw connection address", async () => {
    await withTestApp(undefined, async (app, sessionCookie) => {
      const response = await app.inject({
        method: "GET",
        url: "/__test/ip",
        headers: { cookie: sessionCookie, "x-forwarded-for": "203.0.113.5" },
      });
      expect(response.json<{ ip: string }>().ip).not.toBe("203.0.113.5");
    });
  });

  it("explicitly false behaves the same as unset", async () => {
    await withTestApp(false, async (app, sessionCookie) => {
      const response = await app.inject({
        method: "GET",
        url: "/__test/ip",
        headers: { cookie: sessionCookie, "x-forwarded-for": "203.0.113.5" },
      });
      expect(response.json<{ ip: string }>().ip).not.toBe("203.0.113.5");
    });
  });

  it("when true, request.ip reflects X-Forwarded-For — proves the option actually reaches Fastify", async () => {
    await withTestApp(true, async (app, sessionCookie) => {
      const response = await app.inject({
        method: "GET",
        url: "/__test/ip",
        headers: { cookie: sessionCookie, "x-forwarded-for": "203.0.113.5" },
      });
      expect(response.json<{ ip: string }>().ip).toBe("203.0.113.5");
    });
  });
});
