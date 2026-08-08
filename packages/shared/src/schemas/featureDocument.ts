import { z } from "zod";

export const FeatureDocumentSchema = z.object({
  id: z.string().uuid(),
  featureId: z.string(),
  generatedAt: z.date(),
  sourceTestRunId: z.string().uuid(),
  activeLearningIds: z.array(z.string().uuid()),
  content: z.string(),
  model: z.string(),
  llmCallsUsed: z.number().int().min(0),
  costUsd: z.number().min(0),
  triggeredBy: z.string().optional(),
});

export type FeatureDocument = z.infer<typeof FeatureDocumentSchema>;
