import { installMockTarget, installNavigationGuard } from "@silly-rabbit/driver";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { locateSection } from "../sectionLocate.js";

const MOCK_BASE_URL = "http://mock.local";
const LIST_PATH = "/fleet/auth/platform/locations";

describe("locateSection (explorer-spec §5, real chromium + the D3 mock target)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    context = await browser.newContext();
    await installMockTarget(context, "baseline", {
      recordId: randomUUID(),
      timestamp: new Date().toISOString(),
      count: 1,
    });
    page = await context.newPage();
    await page.goto(`${MOCK_BASE_URL}${LIST_PATH}`);
  });

  afterEach(async () => {
    await context.close();
  });

  it("finds a case-insensitive substring match and clicks through to the resolved sectionUrl", async () => {
    const result = await locateSection(page, "warehouse");
    expect(result?.matchedLabel).toBe("Main Warehouse");
    expect(result?.sectionUrl).toContain("/fleet/auth/platform/locations/1");
    expect(page.url()).toContain("/fleet/auth/platform/locations/1");
  });

  it("returns undefined when no nav link matches (explorer-spec §11.2 path)", async () => {
    const result = await locateSection(page, "nonexistent-section-xyz");
    expect(result).toBeUndefined();
  });

  it("a description given in the wrong locale doesn't match — same not-found path as any other miss (§5 locale constraint)", async () => {
    const result = await locateSection(page, "Standorte");
    expect(result).toBeUndefined();
  });

  it("routes the resolved URL through onBeforeNavigate before clicking", async () => {
    const onBeforeNavigate = vi.fn();
    const result = await locateSection(page, "warehouse", { onBeforeNavigate });
    expect(onBeforeNavigate).toHaveBeenCalledWith(result?.sectionUrl);
  });
});

describe("locateSection — click-path (no href), real chromium, mirrors the real target's listitem-only nav shape", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it(
    "matches a role:listitem element with no href, clicks it directly, and captures the post-click URL " +
      "(not a pre-resolved one — none exists to resolve)",
    async () => {
      page = await browser.newPage();
      await page.route("https://allowed.example/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<html><body><h1>Standorte Section</h1></body></html>" }),
      );
      await page.setContent(
        `<html><body><h1>Home</h1>
        <ul><li onclick="window.location.href='https://allowed.example/section'">Standorte</li></ul>
      </body></html>`,
      );

      const result = await locateSection(page, "Standorte");

      expect(result?.matchedLabel).toBe("Standorte");
      expect(result?.sectionUrl).toBe("https://allowed.example/section");
      expect(page.url()).toBe("https://allowed.example/section");
    },
  );

  it(
    "a multi-word description containing the correct single-word label as one of its words now matches " +
      "('Standorte' is a real nav label confirmed via live diagnostic run; whole-phrase containment could " +
      "never match it, word-level containment does)",
    async () => {
      page = await browser.newPage();
      await page.setContent(
        `<html><body><h1>Home</h1>
        <ul><li>Standorte</li></ul>
      </body></html>`,
      );

      const result = await locateSection(page, "the standorte list and detail view");

      expect(result?.matchedLabel).toBe("Standorte");
    },
  );

  it(
    "a short (2-char) label doesn't false-positive against an unrelated word that happens to contain it " +
      "as a substring (word-direction containment is guarded to labels of meaningful length)",
    async () => {
      page = await browser.newPage();
      await page.setContent(
        `<html><body><h1>Home</h1>
        <ul><li>OK</li></ul>
      </body></html>`,
      );

      const result = await locateSection(page, "the booking list and detail view");

      expect(result).toBeUndefined();
    },
  );

  it(
    "routes the click-path match through onBeforeAction (same assertNotDestructive discipline as every " +
      "other click), not onBeforeNavigate — there is no URL to pre-check",
    async () => {
      page = await browser.newPage();
      await page.route("https://allowed.example/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<html><body><h1>Section</h1></body></html>" }),
      );
      await page.setContent(
        `<html><body><h1>Home</h1>
        <ul><li onclick="window.location.href='https://allowed.example/section'">Standorte</li></ul>
      </body></html>`,
      );

      const onBeforeAction = vi.fn();
      const onBeforeNavigate = vi.fn();
      await locateSection(page, "Standorte", { onBeforeAction, onBeforeNavigate });

      expect(onBeforeAction).toHaveBeenCalledWith({ role: "listitem", accessibleName: "Standorte" });
      expect(onBeforeNavigate).not.toHaveBeenCalled();
    },
  );

  it(
    "a click-path match to a disallowed destination is blocked by the request-level navigationGuard — " +
      "the ONLY thing protecting this path, since there's no href to pre-check via onBeforeNavigate",
    async () => {
      page = await browser.newPage();
      await page.route("https://blocked.example/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<html><body><h1>Blocked Landed</h1></body></html>" }),
      );
      await page.setContent(
        `<html><body><h1>Home</h1>
        <ul><li onclick="window.location.href='https://blocked.example/section'">Standorte</li></ul>
      </body></html>`,
      );
      await installNavigationGuard(page, {
        isNavigationAllowed: (url) => {
          const host = new URL(url).host;
          return host === "allowed.example" ? { allowed: true } : { allowed: false, reason: `host "${host}" not allowed` };
        },
      });

      const result = await locateSection(page, "Standorte");

      expect(result?.matchedLabel).toBe("Standorte");
      expect(page.url()).not.toBe("https://blocked.example/section");
      expect(await page.getByText("Blocked Landed").count()).toBe(0);
    },
  );
});
