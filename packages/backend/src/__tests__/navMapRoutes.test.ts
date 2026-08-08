import type { AnthropicLike } from "@silly-rabbit/engine";
import type { NavMap } from "@silly-rabbit/shared";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { BrowserContext } from "playwright";
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

const NAV_MAP_ORIGIN = "https://nav-map-route.example.com";

function throwingJudgeClient(): AnthropicLike {
  return { messages: { create: () => { throw new Error("judge should not be called by a NavMap crawl"); } } };
}

async function installRoutes(context: BrowserContext): Promise<void> {
  await context.route(`${NAV_MAP_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<html><body><a href="/">Home</a></body></html>` }),
  );
}

async function buildDeps(includeNavMap: boolean, connection: MongoConnection): Promise<AppDeps> {
  const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-navmap-"));
  const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-navmap-"));
  return {
    runRepo: new RunRepo(connection.db),
    findingRepo: new FindingRepo(connection.db),
    baselineRepo: new BaselineRepo(connection.db),
    appMapRepo: new AppMapRepo(connection.db),
    testRunRepo: new TestRunRepo(connection.db),
    learningRepo: new LearningRepo(connection.db),
    featureDocumentRepo: new FeatureDocumentRepo(connection.db),
    sessionRecordingRepo: new SessionRecordingRepo(connection.db),
    sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
    navMapRepo: includeNavMap ? new NavMapRepo(connection.db) : undefined,
    reproSpecDirectory,
    screenshotDirectory,
    screenshotStorageCapBytes: 1_000_000_000,
    judgeClientFactory: throwingJudgeClient,
    allowedDomains: [new URL(NAV_MAP_ORIGIN).host],
    productionUrlPatterns: [],
    corsOrigins: ["http://localhost:5173"],
    dashboardPassword: "test-password",
    sessionSecret: "test-session-secret",
    cookieSecure: false,
    cookieSameSite: "lax",
    installRoutes,
  };
}

async function buildAuthedApp(
  deps: AppDeps,
): Promise<{ app: FastifyInstance; injectAuthed: (options: InjectOptions) => Promise<LightMyRequestResponse> }> {
  const app = buildApp(deps);
  const loginResponse = await app.inject({ method: "POST", url: "/auth/login", payload: { password: deps.dashboardPassword } });
  const sessionCookie = loginResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  return {
    app,
    injectAuthed: (options) => app.inject({ ...options, headers: { ...options.headers, cookie: sessionCookie } }),
  };
}

describe("nav-map routes (app-mapping-spec.md §8 manual trigger)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
  });

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("POST /nav-map/crawl is a 404 when navMapRepo isn't configured on this deployment", async () => {
    const { app, injectAuthed } = await buildAuthedApp(await buildDeps(false, connection));
    const response = await injectAuthed({ method: "POST", url: "/nav-map/crawl", payload: { baseUrl: NAV_MAP_ORIGIN } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("POST /nav-map/crawl runs synchronously and returns the built NavMap; GET /nav-map then retrieves it", async () => {
    const { app, injectAuthed } = await buildAuthedApp(await buildDeps(true, connection));

    const crawlResponse = await injectAuthed({ method: "POST", url: "/nav-map/crawl", payload: { baseUrl: NAV_MAP_ORIGIN } });
    expect(crawlResponse.statusCode).toBe(200);
    const navMap = crawlResponse.json<NavMap>();
    expect(navMap.baseUrl).toBe(NAV_MAP_ORIGIN);
    expect(navMap.entries.map((entry) => entry.label)).toEqual(["Home"]);

    const getResponse = await injectAuthed({ method: "GET", url: `/nav-map?baseUrl=${encodeURIComponent(NAV_MAP_ORIGIN)}` });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json<NavMap>().id).toBe(navMap.id);

    await app.close();
  });

  it("GET /nav-map for a baseUrl that's never been crawled is a 404", async () => {
    const { app, injectAuthed } = await buildAuthedApp(await buildDeps(true, connection));
    const response = await injectAuthed({ method: "GET", url: `/nav-map?baseUrl=${encodeURIComponent("https://never-crawled.example.com")}` });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("DELETE /nav-map really removes the document — GET afterward is a 404, not a stale hit", async () => {
    const { app, injectAuthed } = await buildAuthedApp(await buildDeps(true, connection));

    const crawlResponse = await injectAuthed({ method: "POST", url: "/nav-map/crawl", payload: { baseUrl: NAV_MAP_ORIGIN } });
    expect(crawlResponse.statusCode).toBe(200);

    const deleteResponse = await injectAuthed({
      method: "DELETE",
      url: `/nav-map?baseUrl=${encodeURIComponent(NAV_MAP_ORIGIN)}`,
    });
    expect(deleteResponse.statusCode).toBe(204);

    const getResponse = await injectAuthed({ method: "GET", url: `/nav-map?baseUrl=${encodeURIComponent(NAV_MAP_ORIGIN)}` });
    expect(getResponse.statusCode).toBe(404);

    await app.close();
  });

  it("DELETE /nav-map for a baseUrl with no NavMap is a 404, not a silent no-op success", async () => {
    const { app, injectAuthed } = await buildAuthedApp(await buildDeps(true, connection));
    const response = await injectAuthed({
      method: "DELETE",
      url: `/nav-map?baseUrl=${encodeURIComponent("https://never-crawled-for-delete.example.com")}`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
