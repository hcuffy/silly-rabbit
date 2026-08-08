import { describe, expect, it } from "vitest";
import { FeatureDocumentSchema } from "../featureDocument.js";

describe("FeatureDocumentSchema", () => {
  it("parses a valid feature doc", () => {
    const result = FeatureDocumentSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      featureId: "locations",
      generatedAt: new Date(),
      sourceTestRunId: "11111111-1111-4111-8111-111111111111",
      activeLearningIds: ["22222222-2222-4222-8222-222222222222"],
      content: "# Locations\n\nThis feature lists locations.",
      model: "claude-sonnet-4-6",
      llmCallsUsed: 1,
      costUsd: 0.01,
    });
    expect(result.featureId).toBe("locations");
    expect(result.triggeredBy).toBeUndefined();
  });

  it("accepts triggeredBy when present", () => {
    const result = FeatureDocumentSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      featureId: "locations",
      generatedAt: new Date(),
      sourceTestRunId: "11111111-1111-4111-8111-111111111111",
      activeLearningIds: [],
      content: "doc content",
      model: "claude-sonnet-4-6",
      llmCallsUsed: 1,
      costUsd: 0.01,
      triggeredBy: "henry",
    });
    expect(result.triggeredBy).toBe("henry");
  });

  it("rejects an invalid feature doc", () => {
    expect(() =>
      FeatureDocumentSchema.parse({
        id: "not-a-uuid",
        featureId: "locations",
        generatedAt: new Date(),
        sourceTestRunId: "11111111-1111-4111-8111-111111111111",
        activeLearningIds: [],
        content: "doc content",
        model: "claude-sonnet-4-6",
        llmCallsUsed: -1,
        costUsd: 0.01,
      }),
    ).toThrow();
  });
});
