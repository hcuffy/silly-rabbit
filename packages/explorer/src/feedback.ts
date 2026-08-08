import { FindingSchema, LearningSchema, type Finding, type Learning } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import type { LearningRepoLike } from "./learningContext.js";

export type FeedbackVerdict = "confirmed_issue" | "intended_behavior" | "dismiss";

export interface RecordFeedbackInput {
  finding: Finding;
  featureId: string;
  verdict: FeedbackVerdict;
}

export interface FindingRepoLike {
  upsert(finding: Finding): Promise<void>;
}

export async function recordFeedback(
  input: RecordFeedbackInput,
  learningRepo: Pick<LearningRepoLike, "findByDedupKey" | "upsert">,
  findingRepo: Pick<FindingRepoLike, "upsert">,
): Promise<void> {
  if (input.verdict === "dismiss") {
    const dismissed = FindingSchema.parse({ ...input.finding, status: "DISMISSED", updatedAt: new Date() });
    await findingRepo.upsert(dismissed);
    return;
  }

  const now = new Date();
  const existing = await learningRepo.findByDedupKey(input.featureId, input.finding.dedupKey);

  const learning: Learning = existing
    ? { ...existing, learningType: input.verdict, lastConfirmedRunId: input.finding.runId, status: "active", updatedAt: now }
    : {
        id: randomUUID(),
        featureId: input.featureId,
        learningType: input.verdict,
        description: input.finding.reasoning ?? input.finding.dedupKey,
        source: "run_verdict",
        firstSeenRunId: input.finding.runId,
        lastConfirmedRunId: input.finding.runId,
        status: "active",
        dedupKey: input.finding.dedupKey,
        createdAt: now,
        updatedAt: now,
      };

  await learningRepo.upsert(LearningSchema.parse(learning));

  const updatedFinding = FindingSchema.parse({ ...input.finding, humanVerdict: input.verdict, updatedAt: now });
  await findingRepo.upsert(updatedFinding);
}

export interface InjectLearningInput {
  featureId: string;
  description: string;
}

const USER_INJECTED_SENTINEL_RUN_ID = "user-injected";

export async function injectLearning(
  input: InjectLearningInput,
  learningRepo: Pick<LearningRepoLike, "upsert">,
): Promise<Learning> {
  const now = new Date();
  const learning = LearningSchema.parse({
    id: randomUUID(),
    featureId: input.featureId,
    learningType: "user_injected_check",
    description: input.description,
    source: "user_direct",
    firstSeenRunId: USER_INJECTED_SENTINEL_RUN_ID,
    lastConfirmedRunId: USER_INJECTED_SENTINEL_RUN_ID,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await learningRepo.upsert(learning);
  return learning;
}
