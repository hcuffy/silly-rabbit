import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { researchSection } from "../research.js";

describe("researchSection (explorer-spec §6, real chromium)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("inventories a section's controls and detects the page language", async () => {
    await page.setContent(`
      <html lang="de">
        <body>
          <h1>Standorte</h1>
          <input aria-label="Suchen" />
          <button>Speichern</button>
        </body>
      </html>
    `);

    const inventory = await researchSection(page, "locations");

    expect(inventory.featureId).toBe("locations");
    expect(inventory.sectionHeading).toBe("Standorte");
    expect(inventory.detectedLanguage).toBe("de");
    expect(inventory.elements.some((element) => element.kind === "input")).toBe(true);
    expect(inventory.elements.some((element) => element.kind === "button")).toBe(true);
  });

  it("falls back to 'unknown' language when <html lang> is absent", async () => {
    await page.setContent(`<html><body><h1>No lang here</h1></body></html>`);
    const inventory = await researchSection(page, "locations");
    expect(inventory.detectedLanguage).toBe("unknown");
  });

  it("masks the stored ariaSnapshotMasked through the engine's existing mask pipeline", async () => {
    await page.setContent(`
      <html>
        <body>
          <h1>Locations updated 2026-07-25T15:40:04Z</h1>
          <button>Save</button>
        </body>
      </html>
    `);
    const inventory = await researchSection(page, "locations");
    expect(inventory.ariaSnapshotMasked).not.toContain("2026-07-25T15:40:04Z");
    expect(inventory.ariaSnapshotMasked).toContain("<TIME>");
  });
});
