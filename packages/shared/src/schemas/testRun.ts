import { z } from "zod";
import { FeatureHypothesisSchema } from "./featureHypothesis.js";
import { ResearchInventorySchema } from "./researchInventory.js";

export const CheckOutcomeSchema = z.object({
  hypothesisId: z.string().uuid(),
  check: z.enum(["happy", "boundary"]),
  result: z.enum(["passed", "failed", "skipped", "timed_out"]),
});

export const TestRunSchema = z.object({
  id: z.string().uuid(),
  featureId: z.string(),
  runId: z.string(),
  research: ResearchInventorySchema,
  testPlan: z.array(FeatureHypothesisSchema),
  checkOutcomes: z.array(CheckOutcomeSchema),
  findingIds: z.array(z.string().uuid()),
  startedAt: z.date(),
  finishedAt: z.date().optional(),
  status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
  error: z.string().optional(),
});

export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;
export type TestRun = z.infer<typeof TestRunSchema>;
