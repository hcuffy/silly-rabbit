import { createHash } from "node:crypto";
import { filterAriaTree, mapAriaTree, parseAriaSnapshot, serializeAriaNode } from "./ariaTree.js";
import { isTransientNode, maskText } from "./mask.js";

export interface FingerprintResult {
  ariaSnapshotMasked: string;
  fingerprint: string;
}

function canonicalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

export function deriveFingerprint(rawAriaSnapshot: string): FingerprintResult {
  const tree = parseAriaSnapshot(rawAriaSnapshot);
  const withoutTransient = filterAriaTree(tree, (node) => !isTransientNode(node));
  const masked = mapAriaTree(withoutTransient, maskText);

  const ariaSnapshotMasked = canonicalize(serializeAriaNode(masked));
  const fingerprint = createHash("sha256").update(ariaSnapshotMasked).digest("hex");

  return { ariaSnapshotMasked, fingerprint };
}
