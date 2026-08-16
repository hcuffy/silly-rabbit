import type { AnthropicLike } from "@silly-rabbit/engine";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { ActiveCycleRepo } from "../repos/activeCycleRepo.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { CycleRepo } from "../repos/cycleRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called by these tests");
      },
    },
  };
}

describe("cycle routes (run-cycles-spec.md §4 — cycle management + overview backend)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let sessionCookie: string;
  let cycleRepo: CycleRepo;

  function injectAuthed(options: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...options, headers: { ...options.headers, cookie: sessionCookie } });
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-cycles-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-cycles-"));

    cycleRepo = new CycleRepo(connection.db);
    await cycleRepo.ensureIndexes();

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
      cycleRepo,
      activeCycleRepo: new ActiveCycleRepo(connection.db),
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

    const loginResponse = await app.inject({ method: "POST", url: "/auth/login", payload: { password: deps.dashboardPassword } });
    sessionCookie = loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("requires auth, same global preHandler as every other route", async () => {
    const response = await app.inject({ method: "GET", url: "/cycles" });
    expect(response.statusCode).toBe(401);
  });

  it("POST creates a cycle with status active and both counters at zero", async () => {
    const response = await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Release 1.0", kind: "release" } });
    expect(response.statusCode).toBe(201);

    const body = response.json<Record<string, unknown>>();
    expect(body.name).toBe("Release 1.0");
    expect(body.kind).toBe("release");
    expect(body.status).toBe("active");
    expect(body.isDefault).toBe(false);
    expect(body.runCounter).toBe(0);
    expect(body.sessionReplayRunCounter).toBe(0);
  });

  it("rejects an invalid POST body (missing kind) with structured JSON, not a stack trace", async () => {
    const response = await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Bad" } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBeTruthy();
  });

  it("GET /cycles/:id returns the created cycle; unknown id is 404", async () => {
    const created = await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Sprint 1", kind: "sprint" } });
    const { id } = created.json<{ id: string }>();

    const response = await injectAuthed({ method: "GET", url: `/cycles/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ name: string }>().name).toBe("Sprint 1");

    const missing = await injectAuthed({ method: "GET", url: "/cycles/00000000-0000-4000-8000-000000000000" });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /cycles filters by status, active cycles listed separately from archived", async () => {
    await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Filter-active", kind: "release" } });
    const toArchive = await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Filter-archived", kind: "release" } });
    const { id: archivedId } = toArchive.json<{ id: string }>();
    await injectAuthed({ method: "POST", url: `/cycles/${archivedId}/archive` });

    const activeList = await injectAuthed({ method: "GET", url: "/cycles?status=active" });
    const activeNames = activeList.json<{ name: string }[]>().map((cycle) => cycle.name);
    expect(activeNames).toContain("Filter-active");
    expect(activeNames).not.toContain("Filter-archived");

    const archivedList = await injectAuthed({ method: "GET", url: "/cycles?status=archived" });
    const archivedNames = archivedList.json<{ name: string }[]>().map((cycle) => cycle.name);
    expect(archivedNames).toContain("Filter-archived");
    expect(archivedNames).not.toContain("Filter-active");
  });

  it("archive flips an active cycle to archived", async () => {
    const created = await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Archive-me", kind: "sprint" } });
    const { id } = created.json<{ id: string }>();

    const response = await injectAuthed({ method: "POST", url: `/cycles/${id}/archive` });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe("archived");
  });

  it("archiving an already-archived cycle is a 409, not a silent success", async () => {
    const created = await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Double-archive", kind: "sprint" } });
    const { id } = created.json<{ id: string }>();
    await injectAuthed({ method: "POST", url: `/cycles/${id}/archive` });

    const response = await injectAuthed({ method: "POST", url: `/cycles/${id}/archive` });
    expect(response.statusCode).toBe(409);
  });

  it("archiving an unknown cycle id is a 404", async () => {
    const response = await injectAuthed({ method: "POST", url: "/cycles/00000000-0000-4000-8000-000000000000/archive" });
    expect(response.statusCode).toBe(404);
  });

  it(
    "archiving the isDefault cycle surfaces the real backend rejection as a structured 409, and the " +
      "cycle stays active in the stored document — not a silent no-op, not a 500",
    async () => {
      await cycleRepo.ensureDefaultCycle();
      const defaults = await injectAuthed({ method: "GET", url: "/cycles?status=active" });
      const defaultCycle = defaults.json<{ id: string; isDefault: boolean }[]>().find((cycle) => cycle.isDefault);
      if (!defaultCycle) {
        throw new Error("unreachable — ensureDefaultCycle was just called");
      }

      const response = await injectAuthed({ method: "POST", url: `/cycles/${defaultCycle.id}/archive` });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toMatch(/uncategorized/i);

      const stillActive = await injectAuthed({ method: "GET", url: `/cycles/${defaultCycle.id}` });
      expect(stillActive.json<{ status: string }>().status).toBe("active");
    },
  );

  it("activate then GET /cycles/active reflects the pointer", async () => {
    const created = await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Activate-me", kind: "release" } });
    const { id } = created.json<{ id: string }>();

    const activateResponse = await injectAuthed({ method: "POST", url: `/cycles/${id}/activate` });
    expect(activateResponse.statusCode).toBe(204);

    const activeResponse = await injectAuthed({ method: "GET", url: "/cycles/active" });
    expect(activeResponse.json<{ cycleId: string | null }>().cycleId).toBe(id);
  });

  it("activate on an unknown id returns 404", async () => {
    const response = await injectAuthed({ method: "POST", url: "/cycles/00000000-0000-4000-8000-000000000000/activate" });
    expect(response.statusCode).toBe(404);
  });

  it("GET /cycles/:id/stats returns run/replay-run counts and finding stats for a fresh cycle (all zero)", async () => {
    const created = await injectAuthed({ method: "POST", url: "/cycles", payload: { name: "Stats-empty", kind: "sprint" } });
    const { id } = created.json<{ id: string }>();

    const response = await injectAuthed({ method: "GET", url: `/cycles/${id}/stats` });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ runCount: number; replayRunCount: number; newCount: number; suppressedCount: number }>();
    expect(body.runCount).toBe(0);
    expect(body.replayRunCount).toBe(0);
    expect(body.newCount).toBe(0);
    expect(body.suppressedCount).toBe(0);
  });

  it("GET /cycles/:id/stats on an unknown id returns 404", async () => {
    const response = await injectAuthed({ method: "GET", url: "/cycles/00000000-0000-4000-8000-000000000000/stats" });
    expect(response.statusCode).toBe(404);
  });
});
