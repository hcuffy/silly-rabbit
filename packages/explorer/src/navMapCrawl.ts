import { deriveFingerprint, normalizeUrl, parseAriaSnapshot, type AriaNode } from "@silly-rabbit/engine";
import type { ActionDescriptor } from "@silly-rabbit/driver";
import { NavMapEntrySchema, type NavMapEntry, type NavMapPageStructure } from "@silly-rabbit/shared";
import type { Page } from "playwright";
import type { PlaywrightRole } from "./happyPathExecutor.js";
import { researchSection } from "./research.js";
import { collectCandidateNodes } from "./sectionLocate.js";
import { escapeRegExp, normalizeLabelForLlmMatchComparison } from "./sectionLocateLlmFallback.js";

export interface NavMapCrawlOptions {
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 100;

interface EntryDraft {
  role: string;
  label: string;
  normalizedUrl?: string;
  parentLabel?: string;
  discoveredAt: Date;
  pageStructure?: NavMapPageStructure;
}

function entryKey(role: string, label: string): string {
  return `${role}::${label}`;
}

async function collectVisibleCandidates(page: Page): Promise<AriaNode[]> {
  const snapshot = await page.ariaSnapshot({ boxes: true });
  return collectCandidateNodes(parseAriaSnapshot(snapshot));
}

export async function capturePageStructure(page: Page, featureIdSeed: string): Promise<NavMapPageStructure> {
  const research = await researchSection(page, featureIdSeed);
  const rawSnapshot = await page.ariaSnapshot({ boxes: true });
  const { fingerprint } = deriveFingerprint(rawSnapshot);

  return {
    detectedLanguage: research.detectedLanguage,
    elements: research.elements,
    entityFields: research.entityFields,
    structureFingerprint: fingerprint,
    researchedAt: new Date(),
  };
}

export async function visitEntry(
  page: Page,
  entry: { role: string; label: string },
  options: NavMapCrawlOptions,
): Promise<boolean> {
  const locatorText = normalizeLabelForLlmMatchComparison(entry.label);
  const locator = page
    .getByRole(entry.role as PlaywrightRole)
    .filter({ hasText: new RegExp(escapeRegExp(locatorText), "i") })
    .first();

  if ((await locator.count()) === 0) return false;

  const href = await locator.getAttribute("href");
  if (href) {
    const targetUrl = new URL(href, page.url()).toString();
    await options.onBeforeNavigate?.(targetUrl);
  }
  await options.onBeforeAction?.({ role: entry.role, accessibleName: entry.label });
  await locator.click();
  await page.waitForLoadState("networkidle");
  return true;
}

export async function crawlNavMap(page: Page, options: NavMapCrawlOptions = {}): Promise<NavMapEntry[]> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const known = new Map<string, EntryDraft>();
  const queue: EntryDraft[] = [];

  function registerCandidates(nodes: AriaNode[], parentLabel: string | undefined): void {
    for (const node of nodes) {
      if (known.size >= maxEntries) return;
      const label = (node.name ?? "").trim();
      if (!label) continue;
      const key = entryKey(node.role, label);
      if (known.has(key)) continue;

      const entry: EntryDraft = { role: node.role, label, parentLabel, discoveredAt: new Date() };
      known.set(key, entry);
      queue.push(entry);
    }
  }

  registerCandidates(await collectVisibleCandidates(page), undefined);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const visited = await visitEntry(page, current, options);
    if (!visited) continue;

    current.normalizedUrl = normalizeUrl(page.url());
    current.pageStructure = await capturePageStructure(page, current.label);

    registerCandidates(await collectVisibleCandidates(page), current.label);
  }

  return [...known.values()].map((draft) =>
    NavMapEntrySchema.parse({
      role: draft.role,
      label: draft.label,
      normalizedUrl: draft.normalizedUrl,
      parentLabel: draft.parentLabel,
      discoveredAt: draft.discoveredAt,
      pageStructure: draft.pageStructure,
    }),
  );
}
