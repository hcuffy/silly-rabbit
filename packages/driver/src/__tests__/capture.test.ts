import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachCapture, captureObservation } from "../capture.js";

describe("attachCapture / captureObservation (driver-spec §3, real chromium)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("captures a console error", async () => {
    const handle = attachCapture(page);
    handle.reset();
    await page.setContent("<h1>Test</h1><script>console.error('boom')</script>");
    const observation = await captureObservation(page, handle);
    expect(observation.consoleErrors).toContain("boom");
  });

  it("captures an uncaught exception via pageerror", async () => {
    const handle = attachCapture(page);
    handle.reset();
    await page.setContent("<h1>Test</h1><script>throw new Error('kaboom')</script>");
    const observation = await captureObservation(page, handle);
    expect(observation.consoleErrors?.some((message) => message.includes("kaboom"))).toBe(true);
  });

  it("captures a 4xx/5xx response", async () => {
    await page.route("https://example.test/**", async (route) => {
      const isFails = new URL(route.request().url()).pathname === "/fails";
      await route.fulfill(isFails ? { status: 500, body: "err" } : { contentType: "text/html", body: "<h1>Test</h1>" });
    });
    const handle = attachCapture(page);
    handle.reset();
    await page.goto("https://example.test/");
    await Promise.all([page.waitForResponse("**/fails"), page.evaluate(() => fetch("/fails").catch(() => undefined))]);
    const observation = await captureObservation(page, handle);
    expect(observation.httpErrors?.[0]).toMatchObject({ method: "GET", status: 500 });
  });

  it("sets isBlank true for an empty body", async () => {
    const handle = attachCapture(page);
    handle.reset();
    await page.setContent("<body></body>");
    const observation = await captureObservation(page, handle);
    expect(observation.isBlank).toBe(true);
  });

  it("sets isBlank false when the body has content", async () => {
    const handle = attachCapture(page);
    handle.reset();
    await page.setContent("<h1>Not blank</h1>");
    const observation = await captureObservation(page, handle);
    expect(observation.isBlank).toBe(false);
  });
});
