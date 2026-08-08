import type { FeatureHypothesis, Learning, ResearchInventory, TestRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { computeCheckDedupKey } from "../dedupSignature.js";
import { buildRunContext, refreshLearningConfirmations, type LearningRepoLike } from "../learningContext.js";

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

function makeHypothesis(overrides: Partial<FeatureHypothesis> = {}): FeatureHypothesis {
  return {
    id: randomUUID(),
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

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  const now = new Date();
  return {
    id: randomUUID(),
    featureId: "locations",
    learningType: "intended_behavior",
    description: "empty name is rejected client-side, this is expected",
    source: "run_verdict",
    firstSeenRunId: "run-0",
    lastConfirmedRunId: "run-0",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("buildRunContext (explorer-spec §10.3)", () => {
  it("pulls active learnings for the given featureId", async () => {
    const active = [makeLearning()];
    const findActiveByFeatureId = vi.fn(() => Promise.resolve(active));
    const learningRepo: Pick<LearningRepoLike, "findActiveByFeatureId"> = { findActiveByFeatureId };

    const context = await buildRunContext("locations", learningRepo);
    expect(context.activeLearnings).toBe(active);
    expect(findActiveByFeatureId).toHaveBeenCalledWith("locations");
  });
});

describe("refreshLearningConfirmations (explorer-spec §10.3 — checkOutcomes-based, not Finding-based)", () => {
  it("bumps lastConfirmedRunId for a Learning whose dedupKey matches a 'passed' checkOutcome this run", async () => {
    const research = makeResearch();
    const hypothesis = makeHypothesis();
    const dedupKey = computeCheckDedupKey(research, hypothesis.boundaryCheck.description, hypothesis.boundaryCheck.category);
    const learning = makeLearning({ dedupKey, lastConfirmedRunId: "run-0" });

    const testRun: TestRun = {
      id: randomUUID(),
      featureId: "locations",
      runId: "run-2",
      research,
      testPlan: [hypothesis],
      checkOutcomes: [
        { hypothesisId: hypothesis.id, check: "happy", result: "failed" },
        { hypothesisId: hypothesis.id, check: "boundary", result: "passed" },
      ],
      findingIds: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "COMPLETED",
    };

    const upserted: Learning[] = [];
    const learningRepo: Pick<LearningRepoLike, "upsert"> = {
      upsert: (input) => {
        upserted.push(input);
        return Promise.resolve();
      },
    };

    await refreshLearningConfirmations(testRun, [learning], learningRepo);

    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ id: learning.id, lastConfirmedRunId: "run-2" });
  });

  it("does nothing when no active learning's dedupKey matches any passed checkOutcome", async () => {
    const research = makeResearch();
    const hypothesis = makeHypothesis();
    const learning = makeLearning({ dedupKey: "unrelated-dedup-key" });

    const testRun: TestRun = {
      id: randomUUID(),
      featureId: "locations",
      runId: "run-2",
      research,
      testPlan: [hypothesis],
      checkOutcomes: [{ hypothesisId: hypothesis.id, check: "happy", result: "passed" }],
      findingIds: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "COMPLETED",
    };

    const upsert = vi.fn(() => Promise.resolve());
    await refreshLearningConfirmations(testRun, [learning], { upsert });

    expect(upsert).not.toHaveBeenCalled();
  });

  it("skips a checkOutcome that isn't 'passed' — a failing or skipped check confirms nothing", async () => {
    const research = makeResearch();
    const hypothesis = makeHypothesis();
    const dedupKey = computeCheckDedupKey(research, hypothesis.happyPathCheck.description);
    const learning = makeLearning({ dedupKey });

    const testRun: TestRun = {
      id: randomUUID(),
      featureId: "locations",
      runId: "run-2",
      research,
      testPlan: [hypothesis],
      checkOutcomes: [{ hypothesisId: hypothesis.id, check: "happy", result: "failed" }],
      findingIds: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "COMPLETED",
    };

    const upsert = vi.fn(() => Promise.resolve());
    await refreshLearningConfirmations(testRun, [learning], { upsert });

    expect(upsert).not.toHaveBeenCalled();
  });

  it("a Learning with no dedupKey (e.g. a fresh user_injected_check) is never matched, never crashes", async () => {
    const research = makeResearch();
    const hypothesis = makeHypothesis();
    const learning = makeLearning({ dedupKey: undefined, learningType: "user_injected_check" });

    const testRun: TestRun = {
      id: randomUUID(),
      featureId: "locations",
      runId: "run-2",
      research,
      testPlan: [hypothesis],
      checkOutcomes: [{ hypothesisId: hypothesis.id, check: "happy", result: "passed" }],
      findingIds: [],
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "COMPLETED",
    };

    const upsert = vi.fn(() => Promise.resolve());
    await refreshLearningConfirmations(testRun, [learning], { upsert });

    expect(upsert).not.toHaveBeenCalled();
  });
});
