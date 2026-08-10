import {
  deriveFingerprint,
  findFirstNode,
  normalizeUrl,
  parseAriaSnapshot,
  type AnthropicLike,
  type AriaNode,
} from "@silly-rabbit/engine";
import type { ActionDescriptor } from "@silly-rabbit/driver";
import type { NavMap, NavMapEntry } from "@silly-rabbit/shared";
import type { Page } from "playwright";
import type { PlaywrightRole } from "./happyPathExecutor.js";
import {
  escapeRegExp,
  matchSectionWithLlm,
  normalizeLabelForLlmMatchComparison,
  type SectionCandidate,
} from "./sectionLocateLlmFallback.js";

export interface SectionLocateOptions {
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
  llmClientFactory?: () => AnthropicLike;
  navMap?: NavMap;
  onNavMapEntryVerified?: (entry: NavMapEntry) => Promise<void> | void;
  onNavMapEntryStale?: (entry: NavMapEntry) => Promise<void> | void;
  onNavMapEntryRelabeled?: (entry: NavMapEntry, newLabel: string) => Promise<void> | void;
}

export interface SectionLocateResult {
  sectionUrl: string;
  matchedLabel: string;
  matchSource: "word" | "llm" | "map";
  llmConfidence?: number;
}

const SECTION_MATCH_ROLES = new Set(["link", "listitem", "button"]);

const LLM_FALLBACK_CANDIDATE_ROLES = new Set(["link", "listitem"]);

const CONNECTOR_STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "in", "on", "at", "to", "for", "with", "is", "are",
]);
const GENERIC_NOUN_STOPWORDS = new Set([
  "detail", "details", "list", "view", "section", "item", "items", "page",
]);
const STOPWORDS = new Set([...CONNECTOR_STOPWORDS, ...GENERIC_NOUN_STOPWORDS]);
const MIN_SIGNIFICANT_WORD_LENGTH = 3;

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

interface SignificantWordsResult {
  words: string[];
  isFallback: boolean;
}

function significantWords(description: string): SignificantWordsResult {
  const candidateWords = tokenize(description).filter((word) => word.length >= MIN_SIGNIFICANT_WORD_LENGTH);

  const withoutAllStopwords = candidateWords.filter((word) => !STOPWORDS.has(word));
  if (withoutAllStopwords.length > 0) return { words: withoutAllStopwords, isFallback: false };

  const withoutConnectorsOnly = candidateWords.filter((word) => !CONNECTOR_STOPWORDS.has(word));
  return {
    words: withoutConnectorsOnly.length > 0 ? withoutConnectorsOnly : candidateWords,
    isFallback: true,
  };
}

export function collectCandidateNodes(node: AriaNode, out: AriaNode[] = []): AriaNode[] {
  for (const child of node.children) {
    if (LLM_FALLBACK_CANDIDATE_ROLES.has(child.role) && (child.name ?? "").trim().length > 0) out.push(child);
    collectCandidateNodes(child, out);
  }
  return out;
}

function matchesSignificantWords(rawLabel: string, words: string[], isFallback: boolean): boolean {
  const label = rawLabel.trim().toLowerCase();
  if (!label) return false;
  const labelTokens = tokenize(label);

  if (isFallback) {
    const labelSignificantTokens = labelTokens.filter((token) => token.length >= MIN_SIGNIFICANT_WORD_LENGTH);
    return labelSignificantTokens.length > 0 && labelSignificantTokens.every((token) => words.includes(token));
  }

  return words.some(
    (word) => labelTokens.includes(word) || (label.length >= MIN_SIGNIFICANT_WORD_LENGTH && word.includes(label)),
  );
}

function findNavMapCandidate(navMap: NavMap, words: string[], isFallback: boolean): NavMapEntry | undefined {
  return navMap.entries.find((entry) => !entry.isStale && matchesSignificantWords(entry.label, words, isFallback));
}

async function verifyNavMapCandidate(page: Page, candidate: NavMapEntry): Promise<boolean> {
  const locatorText = normalizeLabelForLlmMatchComparison(candidate.label);
  const locator = page.getByRole(candidate.role).filter({ hasText: new RegExp(escapeRegExp(locatorText), "i") });
  return (await locator.count()) > 0;
}

async function corroboratesSameDestination(
  page: Page,
  candidate: NavMapEntry,
  resolved: SectionLocateResult,
): Promise<boolean> {
  const checks: boolean[] = [];

  if (candidate.normalizedUrl !== undefined) {
    checks.push(candidate.normalizedUrl === normalizeUrl(resolved.sectionUrl));
  }
  if (candidate.pageStructure !== undefined) {
    const rawSnapshot = await page.ariaSnapshot({ boxes: true });
    const { fingerprint } = deriveFingerprint(rawSnapshot);
    checks.push(fingerprint === candidate.pageStructure.structureFingerprint);
  }

  return checks.length > 0 && checks.every(Boolean);
}

async function recordStaleCandidateOutcome(
  page: Page,
  candidate: NavMapEntry,
  resolved: SectionLocateResult | undefined,
  options: SectionLocateOptions,
): Promise<void> {
  if (resolved && (await corroboratesSameDestination(page, candidate, resolved))) {
    await options.onNavMapEntryRelabeled?.(candidate, resolved.matchedLabel);
    return;
  }
  await options.onNavMapEntryStale?.(candidate);
}

interface ResolvedMatch {
  role: string;
  matchedLabel: string;
  matchSource: "word" | "llm" | "map";
  llmConfidence?: number;
}

async function resolveMatch(page: Page, match: ResolvedMatch, options: SectionLocateOptions): Promise<SectionLocateResult> {
  const { role, matchedLabel, matchSource, llmConfidence } = match;
  const locatorText = normalizeLabelForLlmMatchComparison(matchedLabel);
  const locator = page
    .getByRole(role as PlaywrightRole)
    .filter({ hasText: new RegExp(escapeRegExp(locatorText), "i") })
    .first();

  const href = await locator.getAttribute("href");
  if (href) {
    const sectionUrl = new URL(href, page.url()).toString();
    await options.onBeforeNavigate?.(sectionUrl);
    await locator.click();
    await page.waitForLoadState("networkidle");
    return { sectionUrl, matchedLabel, matchSource, llmConfidence };
  }

  const action: ActionDescriptor = { role, accessibleName: matchedLabel };
  await options.onBeforeAction?.(action);
  await locator.click();
  await page.waitForLoadState("networkidle");

  return { sectionUrl: page.url(), matchedLabel, matchSource, llmConfidence };
}

async function resolveViaLiveTiers(
  page: Page,
  sectionDescription: string,
  options: SectionLocateOptions,
): Promise<SectionLocateResult | undefined> {
  const { words, isFallback } = significantWords(sectionDescription);

  const snapshot = await page.ariaSnapshot({ boxes: true });
  const tree = parseAriaSnapshot(snapshot);

  const wordMatch = findFirstNode(tree, (node) => {
    if (!SECTION_MATCH_ROLES.has(node.role)) return false;
    return matchesSignificantWords(node.name ?? "", words, isFallback);
  });
  if (wordMatch) {
    return resolveMatch(page, { role: wordMatch.role, matchedLabel: wordMatch.name ?? "", matchSource: "word" }, options);
  }

  if (!options.llmClientFactory) return undefined;

  const candidateNodes = collectCandidateNodes(tree);
  const candidates: SectionCandidate[] = candidateNodes.map((node) => ({
    role: node.role,
    label: (node.name ?? "").trim(),
  }));

  const llmResult = await matchSectionWithLlm(sectionDescription, candidates, {
    clientFactory: options.llmClientFactory,
  });
  console.log(
    `sectionLocate LLM fallback: description="${sectionDescription}" ` +
      `matchedLabel=${llmResult.matchedLabel ?? "NO_MATCH"} confidence=${llmResult.confidence}`,
  );
  if (!llmResult.matchedLabel) return undefined;

  const normalizedMatchedLabel = normalizeLabelForLlmMatchComparison(llmResult.matchedLabel);
  const matchedCandidate = candidateNodes.find(
    (node) => normalizeLabelForLlmMatchComparison((node.name ?? "").trim()) === normalizedMatchedLabel,
  );
  if (!matchedCandidate) return undefined;

  const realMatchedLabel = (matchedCandidate.name ?? "").trim();
  return resolveMatch(
    page,
    { role: matchedCandidate.role, matchedLabel: realMatchedLabel, matchSource: "llm", llmConfidence: llmResult.confidence },
    options,
  );
}

export async function locateSection(
  page: Page,
  sectionDescription: string,
  options: SectionLocateOptions = {},
): Promise<SectionLocateResult | undefined> {
  let staleCandidate: NavMapEntry | undefined;

  if (options.navMap) {
    const { words, isFallback } = significantWords(sectionDescription);
    const candidate = findNavMapCandidate(options.navMap, words, isFallback);
    if (candidate) {
      if (await verifyNavMapCandidate(page, candidate)) {
        await options.onNavMapEntryVerified?.(candidate);
        return resolveMatch(page, { role: candidate.role, matchedLabel: candidate.label, matchSource: "map" }, options);
      }
      staleCandidate = candidate;
    }
  }

  const result = await resolveViaLiveTiers(page, sectionDescription, options);

  if (staleCandidate) {
    await recordStaleCandidateOutcome(page, staleCandidate, result, options);
  }

  return result;
}
