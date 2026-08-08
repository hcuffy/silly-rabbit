import type { FeatureHypothesis } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { renderTestPlanMarkdown } from "../testPlanMarkdown.js";

function card(overrides: Partial<FeatureHypothesis> = {}): FeatureHypothesis {
  return {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    featureId: "locations",
    assumption: "the name field is required",
    happyPathCheck: {
      description: "Submit a valid location",
      action: "submit",
      expectedOutcome: "the location appears in the table",
    },
    boundaryCheck: {
      description: "Submit with an empty name",
      action: "submit",
      expectedOutcome: "a validation error is shown",
      category: "empty_required",
    },
    ...overrides,
  };
}

describe("renderTestPlanMarkdown (explorer-spec §4.2 — pure view)", () => {
  it("renders a placeholder when the plan is empty (§11.4)", () => {
    expect(renderTestPlanMarkdown([])).toContain("No hypothesis cards generated for this run.");
  });

  it("renders one section per card, with both checks and the boundary category", () => {
    const markdown = renderTestPlanMarkdown([card()]);
    expect(markdown).toContain("1. the name field is required");
    expect(markdown).toContain("**Happy path**: Submit a valid location");
    expect(markdown).toContain("**Boundary** (empty_required): Submit with an empty name");
  });

  it("is a pure function — same input always produces the same output", () => {
    const plan = [card()];
    expect(renderTestPlanMarkdown(plan)).toBe(renderTestPlanMarkdown(plan));
  });
});
