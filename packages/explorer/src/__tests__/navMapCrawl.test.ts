import type { ActionDescriptor } from "@silly-rabbit/driver";
import { assertNotDestructive, SafetyViolation } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { crawlNavMap } from "../navMapCrawl.js";

const ORIGIN = "https://crawl.example";

function html(body: string): { contentType: string; body: string } {
  return { contentType: "text/html", body: `<html><body>${body}</body></html>` };
}

const NAV = `
  <nav>
    <a href="/">Home</a>
    <a href="/settings">Settings</a>
  </nav>
`;

const PAGES: Record<string, string> = {
  "/": html(`${NAV}<main><h1>Dashboard</h1>
    <table><tr><th>Name</th></tr><tr><td>Alpha</td></tr></table></main>`).body,
  "/settings": html(`${NAV}<main><h1>Settings</h1>
    <input aria-label="Display name" />
    <button onclick="window.__deleteClickCount = (window.__deleteClickCount || 0) + 1">Delete Account</button>
    </main>`).body,
};

async function installFixture(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = PAGES[path];
    if (!body) {
      return route.fulfill({ status: 404, body: "not found" });
    }
    return route.fulfill({ contentType: "text/html", body });
  });
}

describe("crawlNavMap (app-mapping-spec.md §5) — real chromium, synthetic multi-page target", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
    await installFixture(page);
    await page.goto(`${ORIGIN}/`);
  });

  afterEach(async () => {
    await page.close();
  });

  it("visits every discovered nav entry, capturing normalizedUrl and a per-screen pageStructure with a real structureFingerprint", async () => {
    const entries = await crawlNavMap(page);

    expect(entries).toHaveLength(2);
    const byLabel = new Map(entries.map((entry) => [entry.label, entry]));

    const home = byLabel.get("Home");
    expect(home?.role).toBe("link");
    expect(home?.normalizedUrl).toContain("crawl.example");
    expect(home?.pageStructure?.elements.some((element) => element.kind === "table")).toBe(true);
    expect(home?.pageStructure?.structureFingerprint).toEqual(expect.any(String));

    const settings = byLabel.get("Settings");
    expect(settings?.pageStructure?.elements.some((element) => element.kind === "input")).toBe(true);

    // Different screen content must produce different fingerprints — proves deriveFingerprint is
    // really being called per-entry, not reused/stubbed across entries.
    expect(home?.pageStructure?.structureFingerprint).not.toBe(settings?.pageStructure?.structureFingerprint);
  });

  it("top-level entries discovered directly on the landing page carry no parentLabel", async () => {
    const entries = await crawlNavMap(page);
    expect(entries.every((entry) => entry.parentLabel === undefined)).toBe(true);
  });

  it(
    "never enters a role:button entry into the map, and never fires the destructive Delete Account " +
      "control — structural safety by construction (crawl only ever collects link/listitem candidates), " +
      "not a policy check that could be bypassed",
    async () => {
      const onBeforeAction = vi.fn<(action: ActionDescriptor) => void>();
      const entries = await crawlNavMap(page, { onBeforeAction });

      expect(entries.some((entry) => entry.role === "button")).toBe(false);
      expect(onBeforeAction.mock.calls.some(([action]) => /delete/i.test(action.accessibleName))).toBe(false);

      const deleteClickCount = await page.evaluate(() => (window as unknown as { __deleteClickCount?: number }).__deleteClickCount);
      expect(deleteClickCount).toBeUndefined();
    },
  );

  it("routes href-based visits through onBeforeNavigate before clicking", async () => {
    const onBeforeNavigate = vi.fn();
    await crawlNavMap(page, { onBeforeNavigate });

    expect(onBeforeNavigate).toHaveBeenCalledWith(expect.stringContaining("/settings"));
  });

  it(
    "runs the real destructive-pattern guard on an href-carrying link entry before clicking it — an <a> whose " +
      "accessible name matches a destructive pattern must be rejected, the same as a button would be",
    async () => {
      const destructiveRoutes: Record<string, string> = {
        "/": html(`<a href="/delete-account" onclick="window.__deleteLinkClicked = true">Delete Account</a>`).body,
      };
      const destructivePage = await browser.newPage();
      await destructivePage.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = destructiveRoutes[path];
        return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "not found" });
      });
      await destructivePage.goto(`${ORIGIN}/`);

      const onBeforeAction = (action: ActionDescriptor): void => assertNotDestructive(action);
      await expect(crawlNavMap(destructivePage, { onBeforeAction })).rejects.toThrow(SafetyViolation);

      const deleteLinkClicked = await destructivePage.evaluate(() => (window as unknown as { __deleteLinkClicked?: boolean }).__deleteLinkClicked);
      expect(deleteLinkClicked).toBeUndefined();

      await destructivePage.close();
    },
  );

  it("respects a flat count cap — stops registering new entries once the cap is reached (CONFIRM-3)", async () => {
    const manyLinksPage = html(Array.from({ length: 8 }, (_, index) => `<a href="/page-${index}">Link ${index}</a>`).join("")).body;
    const routes: Record<string, string> = { "/": manyLinksPage };
    for (let index = 0; index < 8; index += 1) {
      routes[`/page-${index}`] = html("<h1>ok</h1>").body;
    }

    const cappedPage = await browser.newPage();
    await cappedPage.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = routes[path];
      return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "not found" });
    });
    await cappedPage.goto(`${ORIGIN}/`);

    const entries = await crawlNavMap(cappedPage, { maxEntries: 3 });
    expect(entries.length).toBeLessThanOrEqual(3);
    await cappedPage.close();
  });

  it(
    "revisits a candidate's own discovery page before clicking it, so a sidebar item found on the landing " +
      "page is still reachable after the crawl has already navigated away via an earlier-queued link (real-" +
      "target bug: 0 of 23 listitem entries were ever visited on a live crawl, because visitEntry ran " +
      "against whatever page the crawl had already navigated to, not the page the candidate was discovered on)",
    async () => {
      const routes: Record<string, string> = {
        "/": html(`<a href="/quick">Quick Action</a>` + `<ul><li onclick="location.href='/sidebar-target'">Sidebar Item</li></ul>`).body,
        "/quick": html(`<h1>Quick page</h1>`).body,
        "/sidebar-target": html(`<h1>Sidebar target</h1><input aria-label="Detail" />`).body,
      };
      const staleCandidatePage = await browser.newPage();
      await staleCandidatePage.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = routes[path];
        return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "not found" });
      });
      await staleCandidatePage.goto(`${ORIGIN}/`);

      const entries = await crawlNavMap(staleCandidatePage);
      const sidebarItem = entries.find((entry) => entry.label === "Sidebar Item" && entry.role === "listitem");

      expect(sidebarItem?.normalizedUrl).toContain("sidebar-target");
      expect(sidebarItem?.pageStructure?.elements.some((element) => element.kind === "input")).toBe(true);

      await staleCandidatePage.close();
    },
  );
});

describe("crawlNavMap — one level of nav nesting (§4.1), real chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  afterEach(async () => {
    await page.close();
  });

  it(
    "a sidebar section only visible after its parent is clicked is recorded with parentLabel set to the " +
      "parent's label, and — since nothing else is queued ahead of it — is itself visited and given a " +
      "pageStructure",
    async () => {
      const nestedRoutes: Record<string, string> = {
        "/": html(`<a href="/reports">Reports</a>`).body,
        "/reports": html(`<a href="/reports">Reports</a><aside><a href="/reports/a">Report A</a></aside>`).body,
        "/reports/a": html(`<h1>Report A detail</h1><input aria-label="Filter" />`).body,
      };

      page = await browser.newPage();
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = nestedRoutes[path];
        return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "not found" });
      });
      await page.goto(`${ORIGIN}/`);

      const entries = await crawlNavMap(page);
      const byLabel = new Map(entries.map((entry) => [entry.label, entry]));

      expect(byLabel.get("Reports")?.parentLabel).toBeUndefined();
      expect(byLabel.get("Report A")?.parentLabel).toBe("Reports");
      expect(byLabel.get("Report A")?.pageStructure?.elements.some((element) => element.kind === "input")).toBe(true);
    },
  );
});
