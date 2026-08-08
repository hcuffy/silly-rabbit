import type { Learning, TestRun } from "@silly-rabbit/shared";
import { computeCheckDedupKey } from "./dedupSignature.js";

export interface LearningRepoLike {
  findActiveByFeatureId(featureId: string): Promise<Learning[]>;
  findByDedupKey(featureId: string, dedupKey: string): Promise<Learning | null>;
  upsert(learning: Learning): Promise<void>;
}

export async function buildRunContext(
  featureId: string,
  learningRepo: Pick<LearningRepoLike, "findActiveByFeatureId">,
): Promise<{ activeLearnings: Learning[] }> {
  const activeLearnings = await learningRepo.findActiveByFeatureId(featureId);
  return { activeLearnings };
}

export async function refreshLearningConfirmations(
  testRun: TestRun,
  activeLearnings: Learning[],
  learningRepo: Pick<LearningRepoLike, "upsert">,
): Promise<void> {
  const learningsByDedupKey = new Map(
    activeLearnings.filter((learning): learning is Learning & { dedupKey: string } => Boolean(learning.dedupKey))
      .map((learning) => [learning.dedupKey, learning]),
  );
  if (learningsByDedupKey.size === 0) return;

  const hypothesesById = new Map(testRun.testPlan.map((hypothesis) => [hypothesis.id, hypothesis]));

  for (const outcome of testRun.checkOutcomes) {
    if (outcome.result !== "passed") continue;
    const hypothesis = hypothesesById.get(outcome.hypothesisId);
    if (!hypothesis) continue;

    const check = outcome.check === "happy" ? hypothesis.happyPathCheck : hypothesis.boundaryCheck;
    const category = outcome.check === "boundary" ? hypothesis.boundaryCheck.category : undefined;
    const dedupKey = computeCheckDedupKey(testRun.research, check.description, category);

    const learning = learningsByDedupKey.get(dedupKey);
    if (!learning || learning.lastConfirmedRunId === testRun.runId) continue;

    await learningRepo.upsert({ ...learning, lastConfirmedRunId: testRun.runId, updatedAt: new Date() });
  }
}
