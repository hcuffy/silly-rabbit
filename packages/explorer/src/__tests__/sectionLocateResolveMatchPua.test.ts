import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locateSection } from "../sectionLocate.js";

describe("locateSection resolveMatch — PUA icon-glyph locator regression, real chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("resolveMatch's locator finds/clicks a label with a CSS ::before icon glyph absent from rendered " +
    "text — real target shape, the locator regex must not embed the glyph (real bug found verifying the " +
    "PUA-comparison fix)", async () => {
    page = await browser.newPage();
    await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
    await page.setContent(
      `<html><head><style>.icon::before { content: "\\e939"; }</style></head><body><ul>
        <li onclick="window.location.href='https://allowed.example/section'"><i class="icon"></i> Standorte</li>
      </ul></body></html>`,
    );

    const result = await locateSection(page, "Standorte");

    expect(result?.matchedLabel).toBe("\u{E939} Standorte");
    expect(result?.sectionUrl).toBe("https://allowed.example/section");
  });
});
