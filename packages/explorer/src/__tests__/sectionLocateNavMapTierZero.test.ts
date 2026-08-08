import type { AnthropicLike } from "@silly-rabbit/engine";
import type { NavMap, NavMapEntry } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { locateSection } from "../sectionLocate.js";

function entry(overrides: Partial<NavMapEntry>): NavMapEntry {
  return { role: "link", label: "Home", discoveredAt: new Date(), isStale: false, ...overrides };
}

function navMap(entries: NavMapEntry[]): NavMap {
  return { id: "11111111-1111-1111-1111-111111111111", baseUrl: "https://mock.local", entries, crawledAt: new Date(), crawlDurationMs: 0 };
}

function throwingLlmClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("LLM should not be called on the tier-0 map-hit path");
      },
    },
  };
}

describe("locateSection tier-0 (app-mapping-spec.md §7) — real chromium", () => {
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

  it("a map hit that verifies live resolves via matchSource 'map', skipping ariaSnapshot and the LLM entirely " +
    "— this is the real cost saving over tier-1/2's full-tree-scan-then-LLM path", async () => {
    page = await browser.newPage();
    await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
    await page.setContent(
      `<html><body><ul><li onclick="window.location.href='https://allowed.example/section'">Standorte</li></ul></body></html>`,
    );
    const ariaSnapshotSpy = vi.spyOn(page, "ariaSnapshot");
    const llmClientFactory = vi.fn(throwingLlmClient);

    const result = await locateSection(page, "Standorte", {
      navMap: navMap([entry({ role: "listitem", label: "Standorte" })]),
      llmClientFactory,
    });

    expect(result?.matchSource).toBe("map");
    expect(result?.matchedLabel).toBe("Standorte");
    expect(result?.sectionUrl).toBe("https://allowed.example/section");
    expect(ariaSnapshotSpy).not.toHaveBeenCalled();
    expect(llmClientFactory).not.toHaveBeenCalled();
  });

  it("map hit but the entry no longer resolves live falls through to tier-1's real ariaSnapshot scan, " +
    "self-healing rather than trusting or crashing on the stale answer", async () => {
    page = await browser.newPage();
    await page.setContent(`<html><body><ul><li>Standorte</li></ul></body></html>`);
    const onNavMapEntryStale = vi.fn();

    const staleEntry = entry({ role: "listitem", label: "Renamed Section" });
    const result = await locateSection(page, "Renamed Section", {
      navMap: navMap([staleEntry]),
      onNavMapEntryStale,
    });

    expect(onNavMapEntryStale).toHaveBeenCalledWith(staleEntry);
    expect(result).toBeUndefined();
  });

  it("a map that exists but has no entry matching the description at all falls through cleanly to a real " +
    "tier-1 match — no spurious stale-marking for an entry that was never a candidate in the first place",
  async () => {
    page = await browser.newPage();
    await page.setContent(`<html><body><ul><li>Nutzer</li></ul></body></html>`);
    const onNavMapEntryStale = vi.fn();

    const result = await locateSection(page, "Nutzer", {
      navMap: navMap([entry({ role: "listitem", label: "Unrelated Section" })]),
      onNavMapEntryStale,
    });

    expect(result?.matchedLabel).toBe("Nutzer");
    expect(result?.matchSource).toBe("word");
    expect(onNavMapEntryStale).not.toHaveBeenCalled();
  });

  it("no navMap option at all takes the exact same path as before phase 2 — the byte-identical-when-absent " +
    "case", async () => {
    page = await browser.newPage();
    await page.setContent(`<html><body><ul><li>Nutzer</li></ul></body></html>`);

    const result = await locateSection(page, "Nutzer");

    expect(result?.matchedLabel).toBe("Nutzer");
    expect(result?.matchSource).toBe("word");
  });

  it("an empty map (crawled but no entries yet) behaves identically to no map at all", async () => {
    page = await browser.newPage();
    await page.setContent(`<html><body><ul><li>Nutzer</li></ul></body></html>`);

    const result = await locateSection(page, "Nutzer", { navMap: navMap([]) });

    expect(result?.matchedLabel).toBe("Nutzer");
    expect(result?.matchSource).toBe("word");
  });

  describe("the 3 PUA-glyph regressions from earlier this session, re-run against the tier-0 path", () => {
    const iconGlyph = "\u{E939}";

    it("bug 1 shape (f18433c3, LLM round-trip degrading the glyph) cannot recur on tier-0 — there is no LLM " +
      "round-trip in this path at all, the stored glyph-intact label is used verbatim, not an LLM's echo of it",
    async () => {
      page = await browser.newPage();
      await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
      await page.setContent(
        `<html><body><ul><li onclick="window.location.href='https://allowed.example/section'">${iconGlyph} Standorte</li></ul></body></html>`,
      );

      const result = await locateSection(page, "Standorte", {
        navMap: navMap([entry({ role: "listitem", label: `${iconGlyph} Standorte` })]),
      });

      expect(result?.matchedLabel).toBe(`${iconGlyph} Standorte`);
      expect(result?.matchSource).toBe("map");
      expect(result?.sectionUrl).toBe("https://allowed.example/section");
    });

    it("bug 2 shape (650d6843, hasText regex built from the glyph-intact label matching zero live elements) " +
      "is fixed at both the verify step and resolveMatch — both normalize the glyph out before building the " +
      "locator, reusing the same normalizeLabelForLlmMatchComparison fix already proven for tier-1/2", async () => {
      page = await browser.newPage();
      await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
      await page.setContent(
        `<html><body><ul><li onclick="window.location.href='https://allowed.example/section'">${iconGlyph} Standorte</li></ul></body></html>`,
      );

      const result = await locateSection(page, "Standorte", {
        navMap: navMap([entry({ role: "listitem", label: `${iconGlyph} Standorte` })]),
      });

      expect(result?.sectionUrl).toBe("https://allowed.example/section");
    });

    it("bug 3 shape (sessionReplayExecutor's getByRole(role,{name}) exact-match Chromium quirk on listitem) " +
      "doesn't apply here — tier-0 uses the same getByRole(role).filter({hasText}) form sectionLocate.ts has " +
      "always used, never the exact-name form that had the quirk", async () => {
      page = await browser.newPage();
      await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
      await page.setContent(
        `<html><body><ul><li onclick="window.location.href='https://allowed.example/section'">${iconGlyph} Nutzer</li></ul></body></html>`,
      );

      const result = await locateSection(page, "Nutzer", {
        navMap: navMap([entry({ role: "listitem", label: `${iconGlyph} Nutzer` })]),
      });

      expect(result?.matchedLabel).toBe(`${iconGlyph} Nutzer`);
      expect(result?.matchSource).toBe("map");
      expect(result?.sectionUrl).toBe("https://allowed.example/section");
    });
  });
});
