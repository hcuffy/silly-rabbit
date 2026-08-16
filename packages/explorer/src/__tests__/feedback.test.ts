import type { Finding, Learning } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import type { FindingRepoLike } from "../feedback.js";
import { injectLearning, recordFeedback } from "../feedback.js";
import type { LearningRepoLike } from "../learningContext.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  const now = new Date();
  return {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    runId: "run-1",
    screenId: "screen-1",
    type: "BEHAVIOR_CHECK_FAILED",
    verdict: "REGRESSION",
    reasoning: "the name field silently accepts an empty value",
    evidence: {},
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeLearningRepo(existing: Learning | null = null): { repo: LearningRepoLike; upserted: Learning[] } {
  const upserted: Learning[] = [];
  const repo: LearningRepoLike = {
    findActiveByFeatureId: () => Promise.resolve([]),
    findByDedupKey: () => Promise.resolve(existing),
    upsert: (learning: Learning) => {
      upserted.push(learning);
      return Promise.resolve();
    },
  };
  return { repo, upserted };
}

function fakeFindingRepo(): { repo: Pick<FindingRepoLike, "upsert">; upserted: Finding[] } {
  const upserted: Finding[] = [];
  const repo: Pick<FindingRepoLike, "upsert"> = {
    upsert: (finding: Finding) => {
      upserted.push(finding);
      return Promise.resolve();
    },
  };
  return { repo, upserted };
}

describe("recordFeedback (explorer-spec §10.2)", () => {
  it("dismiss updates the Finding's status to DISMISSED and records no Learning", async () => {
    const { repo: learningRepo, upserted: upsertedLearnings } = fakeLearningRepo();
    const { repo: findingRepo, upserted: upsertedFindings } = fakeFindingRepo();
    await recordFeedback({ finding: makeFinding(), featureId: "locations", verdict: "dismiss" }, learningRepo, findingRepo);

    expect(upsertedLearnings).toHaveLength(0);
    expect(upsertedFindings).toHaveLength(1);
    expect(upsertedFindings[0]).toMatchObject({ id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", status: "DISMISSED" });
  });

  it(
    "confirmed_issue creates a new Learning when none exists yet, keyed from the finding's run, " + "and writes humanVerdict onto the Finding itself",
    async () => {
      const { repo: learningRepo, upserted } = fakeLearningRepo(null);
      const { repo: findingRepo, upserted: upsertedFindings } = fakeFindingRepo();
      await recordFeedback({ finding: makeFinding(), featureId: "locations", verdict: "confirmed_issue" }, learningRepo, findingRepo);

      expect(upserted).toHaveLength(1);
      expect(upserted[0]).toMatchObject({
        featureId: "locations",
        learningType: "confirmed_issue",
        source: "run_verdict",
        firstSeenRunId: "run-1",
        lastConfirmedRunId: "run-1",
        status: "active",
        dedupKey: "dedup-1",
      });
      expect(upsertedFindings).toHaveLength(1);
      expect(upsertedFindings[0]).toMatchObject({ id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", humanVerdict: "confirmed_issue" });
    },
  );

  it(
    "intended_behavior on an existing Learning bumps lastConfirmedRunId and status, keeps firstSeenRunId, " +
      "and writes humanVerdict onto the Finding itself",
    async () => {
      const existing: Learning = {
        id: "1a2b3c4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        featureId: "locations",
        learningType: "confirmed_issue",
        description: "old description",
        source: "run_verdict",
        firstSeenRunId: "run-0",
        lastConfirmedRunId: "run-0",
        status: "stale",
        dedupKey: "dedup-1",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      };
      const { repo: learningRepo, upserted } = fakeLearningRepo(existing);
      const { repo: findingRepo, upserted: upsertedFindings } = fakeFindingRepo();
      await recordFeedback(
        { finding: makeFinding({ runId: "run-2" }), featureId: "locations", verdict: "intended_behavior" },
        learningRepo,
        findingRepo,
      );

      expect(upserted).toHaveLength(1);
      expect(upserted[0]).toMatchObject({
        id: "1a2b3c4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        learningType: "intended_behavior",
        firstSeenRunId: "run-0",
        lastConfirmedRunId: "run-2",
        status: "active",
      });
      expect(upsertedFindings).toHaveLength(1);
      expect(upsertedFindings[0]).toMatchObject({ humanVerdict: "intended_behavior" });
    },
  );

  it("dismiss does NOT write humanVerdict — status: DISMISSED remains the only signal for that branch (unchanged by design)", async () => {
    const { repo: learningRepo } = fakeLearningRepo();
    const { repo: findingRepo, upserted: upsertedFindings } = fakeFindingRepo();
    await recordFeedback({ finding: makeFinding(), featureId: "locations", verdict: "dismiss" }, learningRepo, findingRepo);

    expect(upsertedFindings).toHaveLength(1);
    expect(upsertedFindings[0]?.humanVerdict).toBeUndefined();
    expect(upsertedFindings[0]?.status).toBe("DISMISSED");
  });
});

describe("injectLearning (explorer-spec §10.2/§13.10)", () => {
  it("creates a user_injected_check Learning with the 'user-injected' sentinel run id, no dedupKey yet", async () => {
    const { repo, upserted } = fakeLearningRepo();
    const learning = await injectLearning({ featureId: "locations", description: "always check the export button" }, repo);

    expect(learning).toMatchObject({
      featureId: "locations",
      learningType: "user_injected_check",
      source: "user_direct",
      firstSeenRunId: "user-injected",
      lastConfirmedRunId: "user-injected",
      status: "active",
    });
    expect(learning.dedupKey).toBeUndefined();
    expect(upserted).toEqual([learning]);
  });
});
