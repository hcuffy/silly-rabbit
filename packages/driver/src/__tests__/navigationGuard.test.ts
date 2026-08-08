import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installNavigationGuard, type NavigationGuardOptions } from "../navigationGuard.js";

const ALLOWED_HOST_PATTERN = "https://allowed.example/**";
const BLOCKED_HOST_PATTERN = "https://blocked.example/**";

function allowOnly(hostname: string): NavigationGuardOptions["isNavigationAllowed"] {
  return (url) => {
    const host = new URL(url).host;
    return host === hostname ? { allowed: true } : { allowed: false, reason: `host "${host}" is not allowed` };
  };
}

describe("installNavigationGuard (safety-critical, request-level, subsumes onBeforeNavigate)", () => {
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

  it("a JS onclick-driven navigation (no form, no href) to a disallowed host is blocked", async () => {
    page = await browser.newPage();
    await page.route(BLOCKED_HOST_PATTERN, (route) =>
      route.fulfill({ contentType: "text/html", body: "<html><body><h1>Blocked Landed</h1></body></html>" }),
    );
    await page.setContent(
      `<html><body><h1>Start</h1><button type="button" onclick="window.location.href='https://blocked.example/'">Go</button></body></html>`,
    );
    await installNavigationGuard(page, { isNavigationAllowed: allowOnly("allowed.example") });

    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForLoadState("networkidle").catch(() => undefined);

    expect(page.url()).not.toBe("https://blocked.example/");
    expect(await page.getByText("Blocked Landed").count()).toBe(0);
  });

  it("the same JS onclick pattern to an allowed host proceeds normally", async () => {
    page = await browser.newPage();
    await page.route(ALLOWED_HOST_PATTERN, (route) =>
      route.fulfill({ contentType: "text/html", body: "<html><body><h1>Allowed Landed</h1></body></html>" }),
    );
    await page.setContent(
      `<html><body><h1>Start</h1><button type="button" onclick="window.location.href='https://allowed.example/'">Go</button></body></html>`,
    );
    await installNavigationGuard(page, { isNavigationAllowed: allowOnly("allowed.example") });

    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForLoadState("networkidle");

    expect(page.url()).toBe("https://allowed.example/");
    expect(await (page.getByRole("heading", { name: "Allowed Landed" })).isVisible()).toBe(true);
  });

  it("a handler attached via JS after page load (not static markup) is still caught — real-world SPA pattern", async () => {
    page = await browser.newPage();
    await page.route(BLOCKED_HOST_PATTERN, (route) =>
      route.fulfill({ contentType: "text/html", body: "<html><body><h1>Blocked Landed</h1></body></html>" }),
    );
    await page.setContent(`<html><body><h1>Start</h1><button type="button" id="go">Go</button></body></html>`);
    await installNavigationGuard(page, { isNavigationAllowed: allowOnly("allowed.example") });

    await page.evaluate(() => {
      document.getElementById("go")?.addEventListener("click", () => {
        window.location.href = "https://blocked.example/";
      });
    });

    await page.getByRole("button", { name: "Go" }).click();
    await page.waitForLoadState("networkidle").catch(() => undefined);

    expect(page.url()).not.toBe("https://blocked.example/");
    expect(await page.getByText("Blocked Landed").count()).toBe(0);
  });

  it("an existing real <form> submit to an allowed host still completes with the guard installed (no regression)", async () => {
    page = await browser.newPage();
    await page.route("https://allowed.example/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/section") {
        await route.fulfill({
          contentType: "text/html",
          body: `<html><body><h1>Locations</h1><form action="/submit" method="post"><button type="submit">Save</button></form></body></html>`,
        });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: "<html><body><h1>Submitted</h1></body></html>" });
    });
    await installNavigationGuard(page, { isNavigationAllowed: allowOnly("allowed.example") });
    await page.goto("https://allowed.example/section");

    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForLoadState("networkidle");

    expect(page.url()).toBe("https://allowed.example/submit");
    expect(await (page.getByRole("heading", { name: "Submitted" })).isVisible()).toBe(true);
  });

  it("an existing real <a href> link click to an allowed host still completes with the guard installed (no regression)", async () => {
    page = await browser.newPage();
    await page.route("https://allowed.example/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/") {
        await route.fulfill({
          contentType: "text/html",
          body: `<html><body><h1>Locations</h1><a href="/detail">Main Warehouse</a></body></html>`,
        });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: "<html><body><h1>Detail</h1></body></html>" });
    });
    await installNavigationGuard(page, { isNavigationAllowed: allowOnly("allowed.example") });
    await page.goto("https://allowed.example/");

    await page.getByRole("link", { name: "Main Warehouse" }).click();
    await page.waitForLoadState("networkidle");

    expect(page.url()).toBe("https://allowed.example/detail");
    expect(await (page.getByRole("heading", { name: "Detail" })).isVisible()).toBe(true);
  });

  it("fallback() correctness, proven directly: an earlier-registered mock/fixture route still serves an allowed " +
    "navigation, and the guard's abort() unconditionally wins over a mock that would otherwise have served a " +
    "disallowed one", async () => {
    page = await browser.newPage();
    let mockServedBlocked = false;

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://allowed.example/") {
        await route.fulfill({ contentType: "text/html", body: "<html><body><h1>Mock Served Allowed</h1></body></html>" });
        return;
      }
      if (url === "https://blocked.example/") {
        mockServedBlocked = true;
        await route.fulfill({ contentType: "text/html", body: "<html><body><h1>Mock Served Blocked</h1></body></html>" });
        return;
      }
      await route.fallback();
    });
    await installNavigationGuard(page, { isNavigationAllowed: allowOnly("allowed.example") });
    await page.setContent(
      `<html><body><h1>Start</h1>
        <button type="button" id="allowed" onclick="window.location.href='https://allowed.example/'">Allowed</button>
        <button type="button" id="blocked" onclick="window.location.href='https://blocked.example/'">Blocked</button>
      </body></html>`,
    );

    await page.getByRole("button", { name: "Allowed" }).click();
    await page.waitForLoadState("networkidle");
    expect(page.url()).toBe("https://allowed.example/");
    expect(await (page.getByRole("heading", { name: "Mock Served Allowed" })).isVisible()).toBe(true);

    await page.setContent(
      `<html><body><h1>Start Again</h1>
        <button type="button" id="blocked" onclick="window.location.href='https://blocked.example/'">Blocked</button>
      </body></html>`,
    );
    await page.getByRole("button", { name: "Blocked" }).click();
    await page.waitForLoadState("networkidle").catch(() => undefined);

    expect(mockServedBlocked).toBe(false);
    expect(page.url()).not.toContain("blocked.example");
  });
});
