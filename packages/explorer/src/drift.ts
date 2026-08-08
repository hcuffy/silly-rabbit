import type { Finding, Learning } from "@silly-rabbit/shared";

export interface DriftFlag {
  learningId: string;
  featureId: string;
  reason: "previously_intended_now_failing" | "previously_resolved_now_recurring";
}

export function detectDrift(currentFindings: Finding[], learnings: Learning[]): DriftFlag[] {
  const findingsByDedupKey = new Map(currentFindings.map((finding) => [finding.dedupKey, finding]));
  const flags: DriftFlag[] = [];

  for (const learning of learnings) {
    if (!learning.dedupKey) continue;
    const matchingFinding = findingsByDedupKey.get(learning.dedupKey);
    if (!matchingFinding) continue;

    if (learning.learningType === "intended_behavior") {
      flags.push({ learningId: learning.id, featureId: learning.featureId, reason: "previously_intended_now_failing" });
    }
    if (learning.status === "resolved" && matchingFinding.status === "RECURRING") {
      flags.push({ learningId: learning.id, featureId: learning.featureId, reason: "previously_resolved_now_recurring" });
    }
  }

  return flags;
}
