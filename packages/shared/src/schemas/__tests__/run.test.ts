import { describe, expect, it } from "vitest";
import { RunSchema } from "../run.js";

describe("RunSchema", () => {
  it("parses a valid run", () => {
    const result = RunSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      charter: "test the booking flow",
      targetBaseUrl: "https://dev.rabbit.example",
      status: "PENDING",
      startedAt: new Date(),
      stepsUsed: 0,
      llmCallsUsed: 0,
      costUsd: 0,
    });
    expect(result.status).toBe("PENDING");
  });

  it("parses an old doc predating triggeredBy as undefined, not a validation error", () => {
    const result = RunSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      charter: "test the booking flow",
      targetBaseUrl: "https://dev.rabbit.example",
      status: "COMPLETED",
      startedAt: new Date(),
      stepsUsed: 1,
      llmCallsUsed: 0,
      costUsd: 0,
    });
    expect(result.triggeredBy).toBeUndefined();
  });

  it("rejects an invalid run", () => {
    expect(() =>
      RunSchema.parse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        charter: "test the booking flow",
        targetBaseUrl: "not-a-url",
        status: "PENDING",
        startedAt: new Date(),
        stepsUsed: -1,
        llmCallsUsed: 0,
        costUsd: 0,
      }),
    ).toThrow();
  });
});
