import { z } from "zod";

export const LearningSchema = z.object({
  id: z.string().uuid(),
  featureId: z.string(),
  learningType: z.enum(["confirmed_issue", "intended_behavior", "user_injected_check"]),
  description: z.string(),
  source: z.enum(["run_verdict", "user_direct"]),
  firstSeenRunId: z.string(),
  lastConfirmedRunId: z.string(),
  status: z.enum(["active", "resolved", "stale"]),
  dedupKey: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Learning = z.infer<typeof LearningSchema>;
