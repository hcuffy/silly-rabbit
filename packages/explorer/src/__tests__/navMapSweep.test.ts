import { deriveFingerprint, normalizeUrl } from "@silly-rabbit/engine";
import type { NavMap, NavMapEntry } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_NAV_MAP_SWEEP_BATCH_SIZE, pickStalestNavMapEntries, sweepNavMapEntries } from "../navMapSweep.js";

const ORIGIN = "https://sweep.example";

function html(body: string): { contentType: string; body: string } {
  return { contentType: "text/html", body: `<html><body>${body}</body></html>` };
}

function makeEntry(overrides: Partial<NavMapEntry> = {}): NavMapEntry {
  return { role: "link", label: "Home", discoveredAt: new Date(), isStale: false, ...overrides };
}

function makeNavMap(entries: NavMapEntry[]): NavMap {
  return { id: "map-1", baseUrl: `${ORIGIN}/`, entries, crawledAt: new Date(), crawlDurationMs: 0 };
}

describe("pickStalestNavMapEntries (app-mapping-spec.md §6.4) — pure sort/slice, no I/O", () => {
  it("picks the batchSize entries with the oldest lastVerifiedAt first, not array order or randomness", () => {
    const oldest = makeEntry({ label: "Oldest", lastVerifiedAt: new Date("2020-01-01") });
    const middle = makeEntry({ label: "Middle", lastVerifiedAt: new Date("2023-01-01") });
    const newest = makeEntry({ label: "Newest", lastVerifiedAt: new Date("2026-01-01") });
    // Deliberately out of stale-order in the input array, to prove the function sorts rather than trusting input order.
    const entries = [newest, oldest, middle];

    const picked = pickStalestNavMapEntries(entries, 2);

    expect(picked.map((entry) => entry.label)).toEqual(["Oldest", "Middle"]);
  });

  it("treats never-verified entries (no lastVerifiedAt) as the stalest of all", () => {
    const neverVerified = makeEntry({ label: "NeverVerified" });
    const recentlyVerified = makeEntry({ label: "Recent", lastVerifiedAt: new Date("2026-01-01") });

    const picked = pickStalestNavMapEntries([recentlyVerified, neverVerified], 1);

    expect(picked.map((entry) => entry.label)).toEqual(["NeverVerified"]);
  });

  it("excludes the given excludeEntry (the one entry the triggering run itself already verified this pass)", () => {
    const usedThisRun = makeEntry({ label: "UsedThisRun", role: "link" });
    const other = makeEntry({ label: "Other", role: "listitem", lastVerifiedAt: new Date("2020-01-01") });

    const picked = pickStalestNavMapEntries([usedThisRun, other], 5, usedThisRun);

    expect(picked.map((entry) => entry.label)).toEqual(["Other"]);
  });

  it("defaults to a real bounded batch size, not unbounded", () => {
    expect(DEFAULT_NAV_MAP_SWEEP_BATCH_SIZE).toBe(5);
    const manyEntries = Array.from({ length: 20 }, (_, index) => makeEntry({ label: `Entry ${index}` }));
    expect(pickStalestNavMapEntries(manyEntries, DEFAULT_NAV_MAP_SWEEP_BATCH_SIZE)).toHaveLength(5);
  });
});

describe("sweepNavMapEntries (app-mapping-spec.md §6.2/§6.4) — real chromium", () => {
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

  it("nav-label drift: an entry whose stored label no longer resolves live is marked isStale, lastVerifiedAt untouched", async () => {
    page = await browser.newPage();
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill(html(`<a href="/real">Real Link</a>`)));
    await page.goto(`${ORIGIN}/`);

    const ghost = makeEntry({ label: "Ghost Entry", role: "listitem", lastVerifiedAt: undefined });
    const results = await sweepNavMapEntries(page, makeNavMap([ghost]), { batchSize: 1 });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.isStale).toBe(true);
    expect(result.lastVerifiedAt).toBeUndefined();
  });

  it("structure drift: a real fingerprint mismatch is detected — entry self-heals with the fresh structure, " +
    "isStale false, lastVerifiedAt refreshed", async () => {
    page = await browser.newPage();
    const routes: Record<string, { contentType: string; body: string }> = {
      "/": html(`<a href="/settings">Settings</a>`),
      "/settings": html(`<h1>Settings</h1><input aria-label="Display name" /><input aria-label="Timeout" />`),
    };
    await page.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = routes[path];
      return body ? route.fulfill(body) : route.fulfill({ status: 404, body: "not found" });
    });
    await page.goto(`${ORIGIN}/`);

    const staleFingerprint = "0000000000000000000000000000000000000000000000000000000000000000";
    const entry = makeEntry({
      label: "Settings",
      role: "link",
      lastVerifiedAt: new Date("2020-01-01"),
      pageStructure: {
        detectedLanguage: "unknown",
        elements: [],
        entityFields: [],
        structureFingerprint: staleFingerprint,
        researchedAt: new Date("2020-01-01"),
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const results = await sweepNavMapEntries(page, makeNavMap([entry]), { batchSize: 1 });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.pageStructure?.structureFingerprint).not.toBe(staleFingerprint);
    expect(result.isStale).toBe(false);
    expect(result.lastVerifiedAt?.getTime()).toBeGreaterThan(new Date("2020-01-01").getTime());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("structure drift"));
    logSpy.mockRestore();
  });

  it("respects its batch-size bound: a map with many stale entries only ever sweeps batchSize of them", async () => {
    page = await browser.newPage();
    const manyEntries = Array.from({ length: 12 }, (_, index) =>
      makeEntry({ label: `Entry ${index}`, role: "listitem", lastVerifiedAt: new Date(2020, 0, index + 1) }),
    );
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill(html("<p>nothing matches any entry</p>")));
    await page.goto(`${ORIGIN}/`);

    const results = await sweepNavMapEntries(page, makeNavMap(manyEntries), { batchSize: 3 });

    expect(results).toHaveLength(3);
    expect(results.map((entry) => entry.label)).toEqual(["Entry 0", "Entry 1", "Entry 2"]);
  });

  describe("locale-relabel corroboration (navmap-locale-spec.md §4, same pattern as sectionLocate.ts's verify-miss " +
    "path) — a literal-label mismatch is no longer immediately treated as drift", () => {
    it("a locale switch (live label no longer matches, but the entry's own normalizedUrl still resolves to the " +
      "same real, fingerprint-matching destination) self-heals — not marked stale", async () => {
      page = await browser.newPage();
      const routes: Record<string, { contentType: string; body: string }> = {
        "/": html(`<a href="/section">Locations</a>`),
        "/section": html(`<h1>Section</h1><input aria-label="Filter" />`),
      };
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = routes[path];
        return body ? route.fulfill(body) : route.fulfill({ status: 404, body: "not found" });
      });

      await page.goto(`${ORIGIN}/section`);
      const { fingerprint } = deriveFingerprint(await page.ariaSnapshot({ boxes: true }));
      await page.goto(`${ORIGIN}/`);

      const staleEntry = makeEntry({
        label: "Standorte",
        role: "link",
        lastVerifiedAt: new Date("2020-01-01"),
        normalizedUrl: normalizeUrl(`${ORIGIN}/section`),
        pageStructure: {
          detectedLanguage: "de",
          elements: [],
          entityFields: [],
          structureFingerprint: fingerprint,
          researchedAt: new Date("2020-01-01"),
        },
      });

      const results = await sweepNavMapEntries(page, makeNavMap([staleEntry]), { batchSize: 1 });

      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result.isStale).toBe(false);
      expect(result.label).toBe("Standorte");
      expect(result.lastRelabeledAt).toBeInstanceOf(Date);
      expect(result.lastVerifiedAt?.getTime()).toBeGreaterThan(new Date("2020-01-01").getTime());
    });

    it("a genuinely different destination (the stored URL now resolves to different, non-matching content — a " +
      "real removal/regression, not a relabel) still marks the entry stale, not relabeled", async () => {
      page = await browser.newPage();
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/") return route.fulfill(html(`<a href="/somewhere">Different Live Label</a>`));
        return route.fulfill({ status: 404, body: "not found" });
      });
      await page.goto(`${ORIGIN}/`);

      const staleEntry = makeEntry({
        label: "Standorte",
        role: "link",
        lastVerifiedAt: new Date("2020-01-01"),
        normalizedUrl: normalizeUrl(`${ORIGIN}/old-section`),
        pageStructure: {
          detectedLanguage: "de",
          elements: [],
          entityFields: [],
          structureFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
          researchedAt: new Date("2020-01-01"),
        },
      });

      const results = await sweepNavMapEntries(page, makeNavMap([staleEntry]), { batchSize: 1 });

      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result.isStale).toBe(true);
      expect(result.lastRelabeledAt).toBeUndefined();
    });

    it("an entry with no stored normalizedUrl at all cannot be corroborated (the sweep only ever revisits a " +
      "known destination directly — unlike sectionLocate.ts it has no click-through re-resolution step to " +
      "observe a live label from) and is correctly still marked stale, not relabeled", async () => {
      page = await browser.newPage();
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill(html(`<p>nothing matches</p>`)));
      await page.goto(`${ORIGIN}/`);

      const staleEntry = makeEntry({
        label: "Standorte",
        role: "listitem",
        lastVerifiedAt: new Date("2020-01-01"),
        pageStructure: {
          detectedLanguage: "de",
          elements: [],
          entityFields: [],
          structureFingerprint: "1111111111111111111111111111111111111111111111111111111111111111",
          researchedAt: new Date("2020-01-01"),
        },
      });

      const results = await sweepNavMapEntries(page, makeNavMap([staleEntry]), { batchSize: 1 });

      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result.isStale).toBe(true);
      expect(result.lastRelabeledAt).toBeUndefined();
    });
  });
});
