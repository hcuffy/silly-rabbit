import type { BoundaryCheck, Check, ResearchInventory } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { buildCheckExecutionErrorResult, classifyCheckExecutionError } from "../checkExecutionError.js";

function makeResearch(overrides: Partial<ResearchInventory> = {}): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [],
    entityFields: [],
    ariaSnapshotMasked: "- heading",
    capturedAt: new Date(),
    ...overrides,
  };
}

function makeHappyCheck(overrides: Partial<Check> = {}): Check {
  return {
    description: "Submit a valid location",
    action: "submit",
    expectedOutcome: "the location appears in the table",
    ...overrides,
  };
}

function makeBoundaryCheck(overrides: Partial<BoundaryCheck> = {}): BoundaryCheck {
  return {
    description: "Submit with a bad value",
    action: "submit",
    expectedOutcome: "a validation error is shown",
    category: "invalid_input",
    ...overrides,
  };
}

describe("classifyCheckExecutionError (this session's live-incident motivated fix)", () => {
  it("classifies a Playwright-shaped timeout error as timed_out", () => {
    const error = new Error("locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button')");
    expect(classifyCheckExecutionError(error)).toBe("timed_out");
  });

  it("classifies a non-timeout error as failed", () => {
    expect(classifyCheckExecutionError(new Error("Target page, context or browser has been closed"))).toBe("failed");
  });

  it("classifies a non-Error thrown value as failed, never throws itself", () => {
    expect(classifyCheckExecutionError("a string, not an Error")).toBe("failed");
  });
});

describe("buildCheckExecutionErrorResult", () => {
  it("produces a NEEDS_HUMAN/LOW-severity Finding and a matching CheckOutcome, does not throw", () => {
    const research = makeResearch();
    const error = new Error("Timeout 30000ms exceeded waiting for getByRole('button', { name: 'Export' })");

    const result = buildCheckExecutionErrorResult({
      runId: "run-1",
      hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      checkKind: "happy",
      check: makeHappyCheck(),
      research,
      error,
    });

    expect(result.checkOutcome).toEqual({
      hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      check: "happy",
      result: "timed_out",
    });
    expect(result.finding).toMatchObject({
      type: "BEHAVIOR_CHECK_FAILED",
      verdict: "NEEDS_HUMAN",
      severity: "LOW",
      confidence: 0,
      runId: "run-1",
    });
    expect(result.finding.reasoning).toContain("Submit a valid location");
    expect(result.finding.reasoning).toContain("Timeout 30000ms exceeded");
  });

  it("includes the boundary check's category in the dedup signature, same as a judged boundary failure", () => {
    const research = makeResearch();
    const longString = buildCheckExecutionErrorResult({
      runId: "run-1",
      hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      checkKind: "boundary",
      check: makeBoundaryCheck({ category: "long_string" }),
      category: "long_string",
      research,
      error: new Error("boom"),
    });
    const emptyRequired = buildCheckExecutionErrorResult({
      runId: "run-1",
      hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      checkKind: "boundary",
      check: makeBoundaryCheck({ category: "empty_required" }),
      category: "empty_required",
      research,
      error: new Error("boom"),
    });

    expect(longString.finding.dedupKey).not.toBe(emptyRequired.finding.dedupKey);
  });
});
