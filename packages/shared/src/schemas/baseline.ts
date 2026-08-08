import { z } from "zod";

export const BaselineSchema = z.object({
  screenId: z.string(),
  fingerprint: z.string(),
  ariaSnapshotMasked: z.string(),
  capturedAt: z.date(),
  runId: z.string(),
  baselineScreenshotPath: z.string().optional(),
});

export type Baseline = z.infer<typeof BaselineSchema>;
