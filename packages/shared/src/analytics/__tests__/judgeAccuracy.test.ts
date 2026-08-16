import { describe, expect, it } from "vitest";
import type { Finding } from "../../schemas/finding.js";
import { computeJudgeAccuracy } from "../judgeAccuracy.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    runId: "run-1",
    screenId: "screen-1",
    type: "BEHAVIOR_CHECK_FAILED",
    featureId: "locations",
    verdict: "REGRESSION",
    evidence: {},
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("computeJudgeAccuracy", () => {
  it("counts confirmed_issue as agree", () => {
    const stats = computeJudgeAccuracy([makeFinding({ humanVerdict: "confirmed_issue" })]);
    expect(stats).toEqual({ agree: 1, disagree: 0 });
  });

  it("counts intended_behavior as disagree", () => {
    const stats = computeJudgeAccuracy([makeFinding({ humanVerdict: "intended_behavior" })]);
    expect(stats).toEqual({ agree: 0, disagree: 1 });
  });

  it("counts a dismissed REGRESSION as disagree", () => {
    const stats = computeJudgeAccuracy([makeFinding({ status: "DISMISSED" })]);
    expect(stats).toEqual({ agree: 0, disagree: 1 });
  });

  it("excludes findings with no featureId (D1-D7-shaped), even if dismissed", () => {
    const stats = computeJudgeAccuracy([makeFinding({ featureId: undefined, status: "DISMISSED" })]);
    expect(stats).toEqual({ agree: 0, disagree: 0 });
  });

  it("excludes NEEDS_HUMAN verdicts (AI deferred, not a confident verdict to score)", () => {
    const stats = computeJudgeAccuracy([makeFinding({ verdict: "NEEDS_HUMAN", humanVerdict: "confirmed_issue" })]);
    expect(stats).toEqual({ agree: 0, disagree: 0 });
  });

  it("excludes findings with no feedback yet", () => {
    const stats = computeJudgeAccuracy([makeFinding()]);
    expect(stats).toEqual({ agree: 0, disagree: 0 });
  });

  it("returns zeros for an empty list", () => {
    expect(computeJudgeAccuracy([])).toEqual({ agree: 0, disagree: 0 });
  });
});
