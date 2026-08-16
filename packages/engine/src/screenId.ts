import { createHash } from "node:crypto";
import { findFirstNode, parseAriaSnapshot, type AriaNode } from "./ariaTree.js";

const DEFAULT_ID_PATTERN = /^\d+$/;

function collapseTrailingId(segments: string[], idPattern: RegExp): string[] {
  if (segments.length > 0 && idPattern.test(segments[segments.length - 1] ?? "")) {
    return [...segments.slice(0, -1), ":id"];
  }
  return segments;
}

const ROUTE_FRAGMENT = /^#(!?)\//;

function normalizeFragment(hash: string, idPattern: RegExp): string {
  const match = ROUTE_FRAGMENT.exec(hash);
  if (!match) {
    return "";
  }
  const routePart = hash.slice(match[0].length).split("?")[0] ?? "";
  const segments = collapseTrailingId(
    routePart.split("/").filter((segment) => segment.length > 0),
    idPattern,
  );
  return `#${match[1]}/${segments.join("/")}`;
}

export function normalizeUrl(rawUrl: string, idPattern: RegExp = DEFAULT_ID_PATTERN): string {
  const url = new URL(rawUrl);
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const port = url.port ? `:${url.port}` : "";

  const segments = collapseTrailingId(
    url.pathname.split("/").filter((segment) => segment.length > 0),
    idPattern,
  );

  const path = segments.length > 0 ? `/${segments.join("/")}` : "";
  return `${scheme}//${host}${port}${path}${normalizeFragment(url.hash, idPattern)}`;
}

function isHeading(node: AriaNode, level?: string): boolean {
  if (node.role !== "heading") {
    return false;
  }
  if (level === undefined) {
    return true;
  }
  return String(node.attrs.level) === level;
}

export function deriveHeadingAnchor(tree: AriaNode, documentTitle?: string): string {
  const h1 = findFirstNode(tree, (node) => isHeading(node, "1"));
  if (h1?.name) {
    return h1.name;
  }

  const h2 = findFirstNode(tree, (node) => isHeading(node, "2"));
  if (h2?.name) {
    return h2.name;
  }

  return documentTitle ?? "";
}

export interface ScreenIdInput {
  url: string;
  ariaSnapshot: string;
  documentTitle?: string;
}

export interface ScreenIdResult {
  screenId: string;
  normalizedUrl: string;
  headingAnchor: string;
}

export function deriveScreenId(input: ScreenIdInput): ScreenIdResult {
  const normalizedUrl = normalizeUrl(input.url);
  const tree = parseAriaSnapshot(input.ariaSnapshot);
  const headingAnchor = deriveHeadingAnchor(tree, input.documentTitle);
  const screenId = createHash("sha256").update(normalizedUrl).digest("hex");

  return { screenId, normalizedUrl, headingAnchor };
}
