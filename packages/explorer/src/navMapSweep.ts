import type { ActionDescriptor } from "@silly-rabbit/driver";
import type { NavMap, NavMapEntry } from "@silly-rabbit/shared";
import type { Page } from "playwright";
import { capturePageStructure, visitEntry } from "./navMapCrawl.js";

export const DEFAULT_NAV_MAP_SWEEP_BATCH_SIZE = 5;

export interface NavMapSweepOptions {
  batchSize?: number;
  excludeEntry?: NavMapEntry;
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
}

function entryIdentity(entry: NavMapEntry): string {
  return `${entry.role}::${entry.label}`;
}

export function pickStalestNavMapEntries(
  entries: NavMapEntry[],
  batchSize: number,
  excludeEntry?: NavMapEntry,
): NavMapEntry[] {
  const excludeKey = excludeEntry ? entryIdentity(excludeEntry) : undefined;
  const candidates = excludeKey ? entries.filter((entry) => entryIdentity(entry) !== excludeKey) : entries;

  return [...candidates]
    .sort((a, b) => (a.lastVerifiedAt?.getTime() ?? 0) - (b.lastVerifiedAt?.getTime() ?? 0))
    .slice(0, batchSize);
}

async function sweepOneEntry(page: Page, entry: NavMapEntry, options: NavMapSweepOptions): Promise<NavMapEntry> {
  try {
    const resolved = await visitEntry(page, entry, options);
    if (!resolved) {
      console.log(`navMap sweep: nav-label drift — "${entry.label}" (${entry.role}) no longer resolves live`);
      return { ...entry, isStale: true };
    }

    const freshStructure = await capturePageStructure(page, entry.label);
    if (entry.pageStructure && freshStructure.structureFingerprint !== entry.pageStructure.structureFingerprint) {
      console.log(`navMap sweep: structure drift — "${entry.label}" (${entry.role}) fingerprint changed`);
    }

    return { ...entry, isStale: false, lastVerifiedAt: new Date(), pageStructure: freshStructure };
  } catch (error) {
    console.log(`navMap sweep: entry check failed for "${entry.label}" (${entry.role}), marking stale — ${String(error)}`);
    return { ...entry, isStale: true };
  }
}

export async function sweepNavMapEntries(
  page: Page,
  navMap: NavMap,
  options: NavMapSweepOptions = {},
): Promise<NavMapEntry[]> {
  const batchSize = options.batchSize ?? DEFAULT_NAV_MAP_SWEEP_BATCH_SIZE;
  const targets = pickStalestNavMapEntries(navMap.entries, batchSize, options.excludeEntry);

  const results: NavMapEntry[] = [];
  for (const entry of targets) {
    results.push(await sweepOneEntry(page, entry, options));
  }
  return results;
}
