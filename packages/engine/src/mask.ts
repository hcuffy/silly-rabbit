import type { AriaNode } from "./ariaTree.js";

const TRANSIENT_ROLES = new Set(["alert", "status", "progressbar"]);

export function isTransientNode(node: AriaNode): boolean {
  return TRANSIENT_ROLES.has(node.role);
}

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g;
const SIMPLE_DATE = /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g;
const RELATIVE_TIME_AGO = /\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi;
const RELATIVE_TIME_IN = /\bin\s+\d+\s+(?:second|minute|hour|day|week|month|year)s?\b/gi;
const RELATIVE_TIME_NOW = /\bjust now\b/gi;

const GERMAN_TIME_UNITS = "Sekunden?|Minuten?|Stunden?|Tage?n?|Wochen?|Monate?n?|Jahre?n?";
const RELATIVE_TIME_AGO_DE = new RegExp(`\\bvor\\s+\\d+\\s+(?:${GERMAN_TIME_UNITS})\\b`, "gi");
const RELATIVE_TIME_IN_DE = new RegExp(`\\bin\\s+\\d+\\s+(?:${GERMAN_TIME_UNITS})\\b`, "gi");
const RELATIVE_TIME_NOW_DE = /\bgerade eben\b/gi;

const BARE_CLOCK_TIME = /\b(?:[01]\d|2[0-3])[:\s][0-5]\d\b/g;

export const TIME_PATTERNS = [
  ISO_TIMESTAMP,
  SIMPLE_DATE,
  RELATIVE_TIME_AGO,
  RELATIVE_TIME_IN,
  RELATIVE_TIME_NOW,
  RELATIVE_TIME_AGO_DE,
  RELATIVE_TIME_IN_DE,
  RELATIVE_TIME_NOW_DE,
  BARE_CLOCK_TIME,
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX = /\b[0-9a-f]{16,}\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g;
const ID_PATTERNS = [UUID, LONG_HEX, LONG_TOKEN];

const NUMBER_TOKEN = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;

export function canonicalizeNumber(raw: string): string {
  const parts = raw.split(/[.,]/);
  if (parts.length === 1) return parts[0] ?? raw;

  const last = parts[parts.length - 1] ?? "";
  if (last.length <= 2) {
    const integerPart = parts.slice(0, -1).join("");
    return `${integerPart}.${last}`;
  }
  return parts.join("");
}

function matchesWhole(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => {
    const anchored = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace("g", ""));
    return anchored.test(text);
  });
}

function replaceAllPatterns(text: string, patterns: RegExp[], token: string): string {
  return patterns.reduce((accumulator, pattern) => accumulator.replace(pattern, token), text);
}

export function maskText(text: string): string {
  const trimmed = text.trim();
  if (matchesWhole(trimmed, TIME_PATTERNS)) return "<TIME>";
  if (matchesWhole(trimmed, ID_PATTERNS)) return "<ID>";

  let working = replaceAllPatterns(trimmed, TIME_PATTERNS, "<TIME>");
  working = replaceAllPatterns(working, ID_PATTERNS, "<ID>");

  const numbers: string[] = [];
  working = working.replace(NUMBER_TOKEN, (match) => {
    numbers.push(canonicalizeNumber(match));
    return "";
  });

  const specialTokens = [...working.matchAll(/<TIME>|<ID>/g)].map((m) => m[0]);
  const hasOtherWords = working.replace(/<TIME>|<ID>/g, "").trim().length > 0;

  const parts = [...specialTokens, ...numbers];
  if (hasOtherWords) parts.push("<TEXT>");

  return parts.length > 0 ? parts.join(" ") : "<TEXT>";
}

const STACK_LOCATION = /:\d+:\d+\b/g;
const ERROR_NUMBER = /\b\d+\b/g;

export function maskErrorMessage(message: string): string {
  let masked = replaceAllPatterns(message, TIME_PATTERNS, "<TIME>");
  masked = replaceAllPatterns(masked, ID_PATTERNS, "<ID>");
  return masked.replace(STACK_LOCATION, ":<LINE>:<COL>").replace(ERROR_NUMBER, "<NUM>");
}
