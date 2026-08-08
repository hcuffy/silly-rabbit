import { z } from "zod";

export const CheckSchema = z.object({
  description: z.string(),
  action: z.enum(["submit", "filter", "click"]),
  inputValues: z.record(z.string(), z.string()).optional(),
  expectedOutcome: z.string(),
  targetElement: z.string().optional(),
});

export const BoundaryCheckSchema = CheckSchema.extend({
  category: z.enum(["invalid_input", "empty_required", "long_string", "edge_value", "other"]),
});

export const FeatureHypothesisSchema = z.object({
  id: z.string().uuid(),
  featureId: z.string(),
  assumption: z.string(),
  happyPathCheck: CheckSchema,
  boundaryCheck: BoundaryCheckSchema,
});

export type Check = z.infer<typeof CheckSchema>;
export type BoundaryCheck = z.infer<typeof BoundaryCheckSchema>;
export type FeatureHypothesis = z.infer<typeof FeatureHypothesisSchema>;
