import type { BoundaryCheck, Check, FeatureHypothesis } from "@silly-rabbit/shared";

function renderCheck(label: string, check: Check | BoundaryCheck): string {
  const category = "category" in check ? ` (${check.category})` : "";
  return `- **${label}**${category}: ${check.description} — action: ${check.action}, expect: ${check.expectedOutcome}`;
}

function renderCard(card: FeatureHypothesis, index: number): string[] {
  return [
    `## ${index + 1}. ${card.assumption}`,
    renderCheck("Happy path", card.happyPathCheck),
    renderCheck("Boundary", card.boundaryCheck),
    "",
  ];
}

export function renderTestPlanMarkdown(plan: FeatureHypothesis[]): string {
  if (plan.length === 0) return "# Test plan\n\nNo hypothesis cards generated for this run.";
  return ["# Test plan", "", ...plan.flatMap(renderCard)].join("\n");
}
