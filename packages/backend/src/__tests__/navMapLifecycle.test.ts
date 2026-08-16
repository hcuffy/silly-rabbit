import { MongoMemoryServer } from "mongodb-memory-server";
import type { BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { buildNavMap, type NavMapLifecycleDeps } from "../navMapLifecycle.js";
import { NavMapRepo } from "../repos/navMapRepo.js";
import { SafetyViolation } from "../safety.js";

function html(body: string): string {
  return `<html><body>${body}</body></html>`;
}

function installRoutesFor(origin: string, routes: Record<string, string>): (context: BrowserContext) => Promise<void> {
  return async (context) => {
    await context.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = routes[path];
      return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "not found" });
    });
  };
}

const ORIGIN_A = "https://nav-map-lifecycle-a.example.com";
const ORIGIN_B = "https://nav-map-lifecycle-b.example.com";
const NAV = `<nav><a href="/">Home</a><a href="/settings">Settings</a></nav>`;
const ROUTES = {
  "/": html(`${NAV}<h1>Dashboard</h1>`),
  "/settings": html(`${NAV}<h1>Settings</h1><input aria-label="Name" />`),
};

describe("buildNavMap (app-mapping-spec.md §5/§8) — real chromium + mongodb-memory-server end-to-end", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let navMapRepo: NavMapRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    navMapRepo = new NavMapRepo(connection.db);
    await navMapRepo.ensureIndexes();
  });

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  afterEach(async () => {
    await connection.db.collection("navMaps").deleteMany({});
  });

  function baseDeps(overrides: Partial<NavMapLifecycleDeps> = {}): NavMapLifecycleDeps {
    return {
      navMapRepo,
      allowedDomains: [new URL(ORIGIN_A).host, new URL(ORIGIN_B).host],
      productionUrlPatterns: [],
      ...overrides,
    };
  }

  it("crawls a synthetic multi-page target end-to-end and persists a NavMap retrievable by baseUrl", async () => {
    const navMap = await buildNavMap({ baseUrl: ORIGIN_A }, baseDeps({ installRoutes: installRoutesFor(ORIGIN_A, ROUTES) }));

    expect(navMap.baseUrl).toBe(ORIGIN_A);
    expect(navMap.entries).toHaveLength(2);
    expect(navMap.crawlDurationMs).toBeGreaterThanOrEqual(0);

    const persisted = await navMapRepo.getByBaseUrl(ORIGIN_A);
    expect(persisted).toEqual(navMap);
  });

  it(
    "crawling two different baseUrls produces two fully separate persisted NavMaps — real end-to-end proof " +
      "of per-target isolation (repo-level isolation was already proven directly in navMapRepo.test.ts; this " +
      "proves the full buildNavMap → NavMapRepo path doesn't collapse them)",
    async () => {
      const routesB = {
        "/": html(`<a href="/">Only Home</a>`),
      };

      await buildNavMap({ baseUrl: ORIGIN_A }, baseDeps({ installRoutes: installRoutesFor(ORIGIN_A, ROUTES) }));
      await buildNavMap({ baseUrl: ORIGIN_B }, baseDeps({ installRoutes: installRoutesFor(ORIGIN_B, routesB) }));

      const mapA = await navMapRepo.getByBaseUrl(ORIGIN_A);
      const mapB = await navMapRepo.getByBaseUrl(ORIGIN_B);

      expect(mapA?.entries.map((entry) => entry.label).sort()).toEqual(["Home", "Settings"]);
      expect(mapB?.entries.map((entry) => entry.label)).toEqual(["Only Home"]);
      expect(mapA?.id).not.toBe(mapB?.id);
    },
  );

  it("re-crawling the same baseUrl reuses its existing NavMap id and overwrites the stored entries in place", async () => {
    const first = await buildNavMap({ baseUrl: ORIGIN_A }, baseDeps({ installRoutes: installRoutesFor(ORIGIN_A, ROUTES) }));

    const secondRoutes = { "/": html(`<a href="/">Solo Link</a>`) };
    const second = await buildNavMap({ baseUrl: ORIGIN_A }, baseDeps({ installRoutes: installRoutesFor(ORIGIN_A, secondRoutes) }));

    expect(second.id).toBe(first.id);
    expect(second.entries.map((entry) => entry.label)).toEqual(["Solo Link"]);

    const rawCount = await connection.db.collection("navMaps").countDocuments({ baseUrl: ORIGIN_A });
    expect(rawCount).toBe(1);
  });

  it("a baseUrl outside allowedDomains is rejected before any browser is launched or anything is persisted", async () => {
    await expect(buildNavMap({ baseUrl: "https://not-allowed.example.com" }, baseDeps())).rejects.toThrow(SafetyViolation);

    expect(await navMapRepo.getByBaseUrl("https://not-allowed.example.com")).toBeNull();
  });
});
