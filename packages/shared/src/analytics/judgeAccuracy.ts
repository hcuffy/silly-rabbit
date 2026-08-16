import type { Finding } from "../schemas/finding.js";

export interface JudgeAccuracyStats {
  agree: number;
  disagree: number;
}

export function computeJudgeAccuracy(findings: Finding[]): JudgeAccuracyStats {
  let agree = 0;
  let disagree = 0;
  for (const finding of findings) {
    if (finding.featureId === undefined) {
      continue;
    }
    if (finding.verdict !== "REGRESSION") {
      continue;
    }
    if (finding.humanVerdict === "confirmed_issue") {
      agree++;
    } else if (finding.humanVerdict === "intended_behavior" || finding.status === "DISMISSED") {
      disagree++;
    }
  }
  return { agree, disagree };
}
