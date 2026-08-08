import { describe, expect, it } from "vitest";
import { BoundaryCheckSchema, CheckSchema, FeatureHypothesisSchema } from "../featureHypothesis.js";

describe("CheckSchema", () => {
  it("parses a valid check with inputValues present", () => {
    const result = CheckSchema.parse({
      description: "Submit a new location with valid fields",
      action: "submit",
      inputValues: { name: "Test Location" },
      expectedOutcome: "the new location appears in the table",
    });
    expect(result.action).toBe("submit");
  });

  it("parses a valid check with inputValues omitted (e.g. a plain click)", () => {
    const result = CheckSchema.parse({
      description: "Click the export button",
      action: "click",
      expectedOutcome: "a file download starts",
    });
    expect(result.inputValues).toBeUndefined();
  });

  it("parses a valid check with targetElement present, naming the exact button to click", () => {
    const result = CheckSchema.parse({
      description: "Submit a new location with valid fields",
      action: "submit",
      inputValues: { name: "Test Location" },
      expectedOutcome: "the new location appears in the table",
      targetElement: "Add Location",
    });
    expect(result.targetElement).toBe("Add Location");
  });

  it("parses an old check predating targetElement as undefined, not a validation error (backward-compat)", () => {
    const result = CheckSchema.parse({
      description: "Click the export button",
      action: "click",
      expectedOutcome: "a file download starts",
    });
    expect(result.targetElement).toBeUndefined();
  });

  it("rejects a check with an unknown action", () => {
    expect(() =>
      CheckSchema.parse({
        description: "Do something",
        action: "not-a-real-action",
        expectedOutcome: "something happens",
      }),
    ).toThrow();
  });
});

describe("BoundaryCheckSchema", () => {
  it("parses a valid boundary check (Check fields + category)", () => {
    const result = BoundaryCheckSchema.parse({
      description: "Submit with an empty required name field",
      action: "submit",
      expectedOutcome: "a validation error is shown",
      category: "empty_required",
    });
    expect(result.category).toBe("empty_required");
  });

  it("rejects a boundary check missing category", () => {
    expect(() =>
      BoundaryCheckSchema.parse({
        description: "Submit with an empty required name field",
        action: "submit",
        expectedOutcome: "a validation error is shown",
      }),
    ).toThrow();
  });
});

describe("FeatureHypothesisSchema", () => {
  it("parses a valid feature hypothesis card", () => {
    const result = FeatureHypothesisSchema.parse({
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
    });
    expect(result.happyPathCheck.action).toBe("submit");
    expect(result.boundaryCheck.category).toBe("empty_required");
  });

  it("rejects a feature hypothesis with a non-uuid id", () => {
    expect(() =>
      FeatureHypothesisSchema.parse({
        id: "not-a-uuid",
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
      }),
    ).toThrow();
  });
});
