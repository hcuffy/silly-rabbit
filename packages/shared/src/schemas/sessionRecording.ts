import { z } from "zod";

export const SessionRecordingStepSchema = z.object({
  action: z.enum(["click", "fill", "navigate"]),
  selectorStrategy: z.enum(["role", "css"]),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  cssSelector: z.string().optional(),
  value: z.string().optional(),
  timestampOffsetMs: z.number(),
});

export const NetworkCaptureSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number(),
  bodyPath: z.string(),
  timestampOffsetMs: z.number(),
});

export const SessionRecordingSchema = z.object({
  sessionId: z.string().uuid(),
  targetBaseUrl: z.string(),
  recordedAt: z.date(),
  steps: z.array(SessionRecordingStepSchema),
  networkCaptures: z.array(NetworkCaptureSchema).optional(),
});

export type SessionRecordingStep = z.infer<typeof SessionRecordingStepSchema>;
export type NetworkCapture = z.infer<typeof NetworkCaptureSchema>;
export type SessionRecording = z.infer<typeof SessionRecordingSchema>;
