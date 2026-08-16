import { deriveFingerprint, normalizeUrl, type AnthropicLike } from "@silly-rabbit/engine";
import type { NavMap, NavMapEntry } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { locateSection } from "../sectionLocate.js";

function fakeSectionMatchClient(matchedLabel: string, confidence: number): () => AnthropicLike {
  return (): AnthropicLike => ({
    messages: {
      create: () =>
        Promise.resolve({
          content: [{ type: "tool_use", name: "submit_section_match", input: { matchedLabel, confidence } }],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
    },
  });
}

function entry(overrides: Partial<NavMapEntry>): NavMapEntry {
  return { role: "link", label: "Home", discoveredAt: new Date(), isStale: false, ...overrides };
}

function navMap(entries: NavMapEntry[]): NavMap {
  return { id: "11111111-1111-1111-1111-111111111111", baseUrl: "https://mock.local", entries, crawledAt: new Date(), crawlDurationMs: 0 };
}

describe("locateSection tier-0 (app-mapping-spec.md §7) — real chromium, regressions", () => {
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

  describe("the 3 PUA-glyph regressions from earlier this session, re-run against the tier-0 path", () => {
    const iconGlyph = "\u{E939}";

    it(
      "bug 1 shape (f18433c3, LLM round-trip degrading the glyph) cannot recur on tier-0 — there is no LLM " +
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
      },
    );

    it(
      "bug 2 shape (650d6843, hasText regex built from the glyph-intact label matching zero live elements) " +
        "is fixed at both the verify step and resolveMatch — both normalize the glyph out before building the " +
        "locator, reusing the same normalizeLabelForLlmMatchComparison fix already proven for tier-1/2",
      async () => {
        page = await browser.newPage();
        await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
        await page.setContent(
          `<html><body><ul><li onclick="window.location.href='https://allowed.example/section'">${iconGlyph} Standorte</li></ul></body></html>`,
        );

        const result = await locateSection(page, "Standorte", {
          navMap: navMap([entry({ role: "listitem", label: `${iconGlyph} Standorte` })]),
        });

        expect(result?.sectionUrl).toBe("https://allowed.example/section");
      },
    );

    it(
      "bug 3 shape (sessionReplayExecutor's getByRole(role,{name}) exact-match Chromium quirk on listitem) " +
        "doesn't apply here — tier-0 uses the same getByRole(role).filter({hasText}) form sectionLocate.ts has " +
        "always used, never the exact-name form that had the quirk",
      async () => {
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
      },
    );
  });

  describe(
    "locale-relabel corroboration (navmap-locale-spec.md §4) — verify-miss resolves to the same " +
      "destination under a new label vs. a genuinely different destination",
    () => {
      it(
        "a locale switch (same href destination, different live label) self-heals via onNavMapEntryRelabeled " +
          "— does NOT mark the entry stale, even though the stored label no longer verifies live",
        async () => {
          page = await browser.newPage();
          await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
          await page.setContent(`<html><body><a href="https://allowed.example/section">Locations</a></body></html>`);
          const onNavMapEntryStale = vi.fn();
          const onNavMapEntryRelabeled = vi.fn();
          const staleEntry = entry({
            role: "link",
            label: "Standorte",
            normalizedUrl: normalizeUrl("https://allowed.example/section"),
          });

          const result = await locateSection(page, "Standorte", {
            navMap: navMap([staleEntry]),
            llmClientFactory: vi.fn(fakeSectionMatchClient("Locations", 0.9)),
            onNavMapEntryStale,
            onNavMapEntryRelabeled,
          });

          expect(result?.matchedLabel).toBe("Locations");
          expect(result?.matchSource).toBe("llm");
          expect(onNavMapEntryRelabeled).toHaveBeenCalledWith(staleEntry, "Locations");
          expect(onNavMapEntryStale).not.toHaveBeenCalled();
        },
      );

      it(
        "a genuinely different destination (real removal/regression, not a relabel) still marks the entry " +
          "stale — resolving to *something* live is not enough, the destination itself must corroborate",
        async () => {
          page = await browser.newPage();
          await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
          await page.setContent(`<html><body><a href="https://allowed.example/new-different-section">Somewhere Else</a></body></html>`);
          const onNavMapEntryStale = vi.fn();
          const onNavMapEntryRelabeled = vi.fn();
          const staleEntry = entry({
            role: "link",
            label: "Standorte",
            normalizedUrl: normalizeUrl("https://allowed.example/old-section"),
          });

          const result = await locateSection(page, "Standorte", {
            navMap: navMap([staleEntry]),
            llmClientFactory: vi.fn(fakeSectionMatchClient("Somewhere Else", 0.9)),
            onNavMapEntryStale,
            onNavMapEntryRelabeled,
          });

          expect(result?.matchedLabel).toBe("Somewhere Else");
          expect(onNavMapEntryStale).toHaveBeenCalledWith(staleEntry);
          expect(onNavMapEntryRelabeled).not.toHaveBeenCalled();
        },
      );

      it(
        "click-only entry (no href, URL never changes) corroborates via structureFingerprint alone — the " +
          "dual-signal path CONFIRM-2 asked for, proven with a real fingerprint captured from the live page, not " +
          "a hand-typed hash",
        async () => {
          page = await browser.newPage();
          await page.setContent(`<html><body><ul><li>Locations</li></ul></body></html>`);
          const { fingerprint } = deriveFingerprint(await page.ariaSnapshot({ boxes: true }));

          const onNavMapEntryStale = vi.fn();
          const onNavMapEntryRelabeled = vi.fn();
          const staleEntry = entry({
            role: "listitem",
            label: "Standorte",
            pageStructure: {
              detectedLanguage: "de",
              elements: [],
              entityFields: [],
              structureFingerprint: fingerprint,
              researchedAt: new Date(),
            },
          });

          const result = await locateSection(page, "Standorte", {
            navMap: navMap([staleEntry]),
            llmClientFactory: vi.fn(fakeSectionMatchClient("Locations", 0.9)),
            onNavMapEntryStale,
            onNavMapEntryRelabeled,
          });

          expect(result?.matchedLabel).toBe("Locations");
          expect(onNavMapEntryRelabeled).toHaveBeenCalledWith(staleEntry, "Locations");
          expect(onNavMapEntryStale).not.toHaveBeenCalled();
        },
      );
    },
  );
});
