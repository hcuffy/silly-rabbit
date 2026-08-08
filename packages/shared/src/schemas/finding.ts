import { z } from "zod";

export const FindingSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  screenId: z.string(),
  featureId: z.string().optional(),
  origin: z.enum(["charter", "explorer", "session-replay"]).optional(),
  replayMode: z.enum(["live", "mocked"]).optional(),
  type: z.enum([
    "CONSOLE_ERROR",
    "HTTP_ERROR",
    "BLANK_SCREEN",
    "STATE_DIVERGENCE",
    "VISUAL",
    "OTHER",
    "BEHAVIOR_CHECK_FAILED",
  ]),
  verdict: z.enum(["REGRESSION", "INTENDED_CHANGE", "NEEDS_HUMAN", "KNOWN"]).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "WARNING"]).optional(),
  reasoning: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  explanation: z.string().optional(),
  escalatedToOpus: z.boolean().optional(),
  humanVerdict: z.enum(["confirmed_issue", "intended_behavior"]).optional(),
  evidence: z.object({
    ariaSnapshot: z.string().optional(),
    ariaSnapshotBefore: z.string().optional(),
    consoleMessages: z.array(z.string()).optional(),
    networkErrors: z
      .array(z.object({ method: z.string().optional(), url: z.string(), status: z.number() }))
      .optional(),
  }),
  dedupKey: z.string(),
  status: z.enum(["NEW", "RECURRING", "RESOLVED", "DISMISSED"]),
  reproSpecPath: z.string().optional(),
  screenshotPath: z.string().optional(),
  beforeScreenshotPath: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Finding = z.infer<typeof FindingSchema>;
