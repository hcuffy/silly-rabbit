import type { AnthropicLike } from "@silly-rabbit/engine";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { ActiveTargetProfileRepo } from "../repos/activeTargetProfileRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FeatureDocumentRepo } from "../repos/featureDocumentRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TargetProfileRepo } from "../repos/targetProfileRepo.js";
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

function validProfileBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Release",
    baseUrl: "https://release.example.com",
    loginUrl: "https://release.example.com/#/login",
    email: "test@example.com",
    password: "hunter2",
    emailSelector: "#email",
    passwordSelector: "#password",
    submitSelector: "#submit",
    allowedDomains: ["release.example.com"],
    ...overrides,
  };
}

describe("target profile routes (target-profiles-spec.md phase 2 — settings UI backend)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let app: FastifyInstance;
  let sessionCookie: string;

  function injectAuthed(options: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...options, headers: { ...options.headers, cookie: sessionCookie } });
  }

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-tp-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-tp-"));

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
      targetProfileRepo: new TargetProfileRepo(connection.db, "c".repeat(64)),
      activeTargetProfileRepo: new ActiveTargetProfileRepo(connection.db),
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

  it("requires auth, same global preHandler as every other route — no exemption for target-profiles", async () => {
    const response = await app.inject({ method: "GET", url: "/target-profiles" });
    expect(response.statusCode).toBe(401);
  });

  it("POST creates a profile and the response never includes email/password under any field name", async () => {
    const response = await injectAuthed({ method: "POST", url: "/target-profiles", payload: validProfileBody() });
    expect(response.statusCode).toBe(201);

    const body = response.json<Record<string, unknown>>();
    expect(body.name).toBe("Release");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("test@example.com");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("GET /target-profiles/:id never includes email/password either", async () => {
    const created = await injectAuthed({ method: "POST", url: "/target-profiles", payload: validProfileBody({ name: "Get-check" }) });
    const { id } = created.json<{ id: string }>();

    const response = await injectAuthed({ method: "GET", url: `/target-profiles/${id}` });
    const body = response.json<Record<string, unknown>>();

    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("test@example.com");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("GET /target-profiles (list) never includes email/password for any profile", async () => {
    await injectAuthed({ method: "POST", url: "/target-profiles", payload: validProfileBody({ name: "List-check" }) });

    const response = await injectAuthed({ method: "GET", url: "/target-profiles" });
    const body = response.json<Record<string, unknown>[]>();

    expect(body.length).toBeGreaterThan(0);
    for (const profile of body) {
      expect(profile).not.toHaveProperty("email");
      expect(profile).not.toHaveProperty("password");
    }
    expect(JSON.stringify(body)).not.toContain("test@example.com");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("rejects an invalid POST body (missing allowedDomains) with structured JSON, not a stack trace", async () => {
    const response = await injectAuthed({
      method: "POST",
      url: "/target-profiles",
      payload: { name: "Bad", baseUrl: "https://example.com" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBeTruthy();
  });

  it("PUT updates fields, and the response still never includes email/password", async () => {
    const created = await injectAuthed({ method: "POST", url: "/target-profiles", payload: validProfileBody({ name: "Edit-me" }) });
    const { id } = created.json<{ id: string }>();

    const response = await injectAuthed({
      method: "PUT",
      url: `/target-profiles/${id}`,
      payload: { name: "Edited name", password: "new-password" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body.name).toBe("Edited name");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("new-password");
  });

  it("PUT with a 404 id returns 404, not a 500", async () => {
    const response = await injectAuthed({
      method: "PUT",
      url: "/target-profiles/00000000-0000-4000-8000-000000000000",
      payload: { name: "Nope" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("activate then GET /target-profiles/active reflects the active profile id", async () => {
    const created = await injectAuthed({ method: "POST", url: "/target-profiles", payload: validProfileBody({ name: "Activate-me" }) });
    const { id } = created.json<{ id: string }>();

    const activateResponse = await injectAuthed({ method: "POST", url: `/target-profiles/${id}/activate` });
    expect(activateResponse.statusCode).toBe(204);

    const activeResponse = await injectAuthed({ method: "GET", url: "/target-profiles/active" });
    expect(activeResponse.json<{ profileId: string | null }>().profileId).toBe(id);

    await injectAuthed({ method: "DELETE", url: "/target-profiles/active" });
  });

  it("deactivate (DELETE /target-profiles/active) clears the pointer back to null", async () => {
    const created = await injectAuthed({ method: "POST", url: "/target-profiles", payload: validProfileBody({ name: "Deactivate-me" }) });
    const { id } = created.json<{ id: string }>();
    await injectAuthed({ method: "POST", url: `/target-profiles/${id}/activate` });

    const deactivateResponse = await injectAuthed({ method: "DELETE", url: "/target-profiles/active" });
    expect(deactivateResponse.statusCode).toBe(204);

    const activeResponse = await injectAuthed({ method: "GET", url: "/target-profiles/active" });
    expect(activeResponse.json<{ profileId: string | null }>().profileId).toBeNull();
  });

  it("DELETE removes a profile", async () => {
    const created = await injectAuthed({ method: "POST", url: "/target-profiles", payload: validProfileBody({ name: "Delete-me" }) });
    const { id } = created.json<{ id: string }>();

    const deleteResponse = await injectAuthed({ method: "DELETE", url: `/target-profiles/${id}` });
    expect(deleteResponse.statusCode).toBe(204);

    const getResponse = await injectAuthed({ method: "GET", url: `/target-profiles/${id}` });
    expect(getResponse.statusCode).toBe(404);
  });

  it("DELETE on the active profile is blocked with 409, not silently falling back to env-mode", async () => {
    const created = await injectAuthed({ method: "POST", url: "/target-profiles", payload: validProfileBody({ name: "Active-delete-me" }) });
    const { id } = created.json<{ id: string }>();
    await injectAuthed({ method: "POST", url: `/target-profiles/${id}/activate` });

    const deleteResponse = await injectAuthed({ method: "DELETE", url: `/target-profiles/${id}` });
    expect(deleteResponse.statusCode).toBe(409);

    const getResponse = await injectAuthed({ method: "GET", url: `/target-profiles/${id}` });
    expect(getResponse.statusCode).toBe(200);

    await injectAuthed({ method: "DELETE", url: "/target-profiles/active" });
    const deleteAfterDeactivate = await injectAuthed({ method: "DELETE", url: `/target-profiles/${id}` });
    expect(deleteAfterDeactivate.statusCode).toBe(204);
  });

  it("DELETE on an unknown id returns 404, not 204", async () => {
    const response = await injectAuthed({
      method: "DELETE",
      url: "/target-profiles/00000000-0000-4000-8000-000000000000",
    });
    expect(response.statusCode).toBe(404);
  });

  it("activate on an unknown id returns 404", async () => {
    const response = await injectAuthed({
      method: "POST",
      url: "/target-profiles/00000000-0000-4000-8000-000000000000/activate",
    });
    expect(response.statusCode).toBe(404);
  });
});
