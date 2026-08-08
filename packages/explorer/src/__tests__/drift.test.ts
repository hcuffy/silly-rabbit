import type { Finding, Learning } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { detectDrift } from "../drift.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  const now = new Date();
  return {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    runId: "run-2",
    screenId: "screen-1",
    type: "BEHAVIOR_CHECK_FAILED",
    verdict: "REGRESSION",
    evidence: {},
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  const now = new Date();
  return {
    id: "learning-1",
    featureId: "locations",
    learningType: "confirmed_issue",
    description: "settled ground",
    source: "run_verdict",
    firstSeenRunId: "run-0",
    lastConfirmedRunId: "run-0",
    status: "active",
    dedupKey: "dedup-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("detectDrift (explorer-spec §10.4)", () => {
  it("flags previously_intended_now_failing when an intended_behavior Learning's dedupKey now has a Finding", () => {
    const learning = makeLearning({ learningType: "intended_behavior" });
    const finding = makeFinding({ dedupKey: learning.dedupKey });

    const flags = detectDrift([finding], [learning]);

    expect(flags).toEqual([
      { learningId: learning.id, featureId: learning.featureId, reason: "previously_intended_now_failing" },
    ]);
  });

  it("flags previously_resolved_now_recurring when a resolved Learning's dedupKey now has a RECURRING Finding", () => {
    const learning = makeLearning({ learningType: "confirmed_issue", status: "resolved" });
    const finding = makeFinding({ dedupKey: learning.dedupKey, status: "RECURRING" });

    const flags = detectDrift([finding], [learning]);

    expect(flags).toEqual([
      { learningId: learning.id, featureId: learning.featureId, reason: "previously_resolved_now_recurring" },
    ]);
  });

  it("a resolved Learning whose Finding is NEW (not RECURRING) does not flag", () => {
    const learning = makeLearning({ learningType: "confirmed_issue", status: "resolved" });
    const finding = makeFinding({ dedupKey: learning.dedupKey, status: "NEW" });

    expect(detectDrift([finding], [learning])).toEqual([]);
  });

  it("no flag when the Learning's dedupKey has no matching Finding this run — settled ground stays settled", () => {
    const learning = makeLearning({ learningType: "intended_behavior" });
    const unrelatedFinding = makeFinding({ dedupKey: "some-other-dedup-key" });

    expect(detectDrift([unrelatedFinding], [learning])).toEqual([]);
  });

  it("a Learning with no dedupKey is never matched, never crashes", () => {
    const learning = makeLearning({ learningType: "intended_behavior", dedupKey: undefined });
    const finding = makeFinding();

    expect(detectDrift([finding], [learning])).toEqual([]);
  });

  it("a confirmed_issue (still active) Learning whose dedupKey has a Finding is not drift — only intended_behavior " +
    "or resolved->recurring are", () => {
    const learning = makeLearning({ learningType: "confirmed_issue", status: "active" });
    const finding = makeFinding({ dedupKey: learning.dedupKey, status: "RECURRING" });

    expect(detectDrift([finding], [learning])).toEqual([]);
  });
});
