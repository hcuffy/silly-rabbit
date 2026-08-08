import type { Finding } from "../schemas/finding.js";

export interface FindingStats {
  newCount: number;
  suppressedCount: number;
}

export function computeFindingStats(findings: Finding[]): FindingStats {
  let newCount = 0;
  let suppressedCount = 0;
  for (const finding of findings) {
    if (finding.status === "NEW") newCount++;
    else if (finding.status === "RECURRING") suppressedCount++;
  }
  return { newCount, suppressedCount };
}
