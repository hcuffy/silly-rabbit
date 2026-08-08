import { computeDedupKey, deriveScreenId } from "@silly-rabbit/engine";
import type { ResearchInventory } from "@silly-rabbit/shared";

export function buildDedupSignature(description: string, category?: string): string {
  return category ? `${description} :: ${category}` : description;
}

export function computeCheckDedupKey(research: ResearchInventory, description: string, category?: string): string {
  const { screenId } = deriveScreenId({ url: research.sectionUrl, ariaSnapshot: research.ariaSnapshotMasked });
  const maskedSignature = buildDedupSignature(description, category);
  return computeDedupKey({ screenId, type: "BEHAVIOR_CHECK_FAILED", evidence: {}, maskedSignature });
}
