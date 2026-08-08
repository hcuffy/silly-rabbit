import { describe, expect, it } from "vitest";
import { LearningSchema } from "../learning.js";

describe("LearningSchema", () => {
  it("parses a valid run-verdict learning with dedupKey set", () => {
    const result = LearningSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      featureId: "locations",
      learningType: "confirmed_issue",
      description: "the date filter accepts an invalid date without error",
      source: "run_verdict",
      firstSeenRunId: "run-1",
      lastConfirmedRunId: "run-3",
      status: "active",
      dedupKey: "abc123",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.dedupKey).toBe("abc123");
  });

  it("parses a valid user-injected learning with dedupKey omitted (explorer-spec §4.4/§10.2)", () => {
    const result = LearningSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      featureId: "locations",
      learningType: "user_injected_check",
      description: "always re-check the bulk-delete confirmation dialog",
      source: "user_direct",
      firstSeenRunId: "user-injected",
      lastConfirmedRunId: "user-injected",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.dedupKey).toBeUndefined();
  });

  it("rejects a learning with an unknown learningType", () => {
    expect(() =>
      LearningSchema.parse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        featureId: "locations",
        learningType: "not-a-real-type",
        description: "the date filter accepts an invalid date without error",
        source: "run_verdict",
        firstSeenRunId: "run-1",
        lastConfirmedRunId: "run-3",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow();
  });
});
