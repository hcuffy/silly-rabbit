import { z } from "zod";

export const SessionReplayRunSummarySchema = z.object({
  stepsExecuted: z.number().int().min(0),
  stepsDrifted: z.number().int().min(0),
  stepsErrored: z.number().int().min(0),
});

export const SessionReplayRunSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  replayMode: z.enum(["live", "mocked"]),
  status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  summary: SessionReplayRunSummarySchema,
  error: z.string().optional(),
  cycleId: z.string().uuid().optional(),
  replayRunNumber: z.number().int().min(1).optional(),
});

export type SessionReplayRunSummary = z.infer<typeof SessionReplayRunSummarySchema>;
export type SessionReplayRun = z.infer<typeof SessionReplayRunSchema>;
