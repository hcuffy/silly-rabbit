import { describe, expect, it } from "vitest";
import type { FeatureHypothesis } from "../featureHypothesis.js";
import type { ResearchInventory } from "../researchInventory.js";
import { CheckOutcomeSchema, TestRunSchema } from "../testRun.js";

function research(): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [],
    entityFields: [],
    ariaSnapshotMasked: "- table",
    capturedAt: new Date(),
  };
}

function hypothesis(): FeatureHypothesis {
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
  };
}

describe("CheckOutcomeSchema", () => {
  it("parses a valid check outcome", () => {
    const result = CheckOutcomeSchema.parse({
      hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      check: "happy",
      result: "passed",
    });
    expect(result.result).toBe("passed");
  });

  it("accepts 'timed_out' (D8 resilience fix — a hung check degrades instead of killing the run)", () => {
    const result = CheckOutcomeSchema.parse({
      hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      check: "boundary",
      result: "timed_out",
    });
    expect(result.result).toBe("timed_out");
  });

  it("rejects a check outcome with an unknown result", () => {
    expect(() =>
      CheckOutcomeSchema.parse({
        hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        check: "happy",
        result: "not-a-real-result",
      }),
    ).toThrow();
  });
});

describe("TestRunSchema", () => {
  it("parses a valid completed test run", () => {
    const result = TestRunSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      featureId: "locations",
      runId: "run-1",
      research: research(),
      testPlan: [hypothesis()],
      checkOutcomes: [
        { hypothesisId: hypothesis().id, check: "happy", result: "passed" },
      ],
      findingIds: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "COMPLETED",
    });
    expect(result.status).toBe("COMPLETED");
  });

  it("parses a running test run with finishedAt/error omitted (still in flight)", () => {
    const result = TestRunSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      featureId: "locations",
      runId: "run-1",
      research: research(),
      testPlan: [],
      checkOutcomes: [],
      findingIds: [],
      startedAt: new Date(),
      status: "RUNNING",
    });
    expect(result.finishedAt).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("parses a completed test run with an empty test plan and no check outcomes (explorer-spec §11.4)", () => {
    const result = TestRunSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      featureId: "locations",
      runId: "run-1",
      research: research(),
      testPlan: [],
      checkOutcomes: [],
      findingIds: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "COMPLETED",
    });
    expect(result.testPlan).toHaveLength(0);
    expect(result.checkOutcomes).toHaveLength(0);
  });

  it("rejects a test run missing required fields", () => {
    expect(() =>
      TestRunSchema.parse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        featureId: "locations",
        research: research(),
        testPlan: [],
        checkOutcomes: [],
        findingIds: [],
        startedAt: new Date(),
        status: "RUNNING",
      }),
    ).toThrow();
  });
});
