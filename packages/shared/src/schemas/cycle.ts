import { z } from "zod";

export const CycleSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(["sprint", "release"]),
  status: z.enum(["active", "archived"]),
  isDefault: z.boolean().default(false),
  runCounter: z.number().int().min(0),
  sessionReplayRunCounter: z.number().int().min(0),
  createdAt: z.date(),
  archivedAt: z.date().optional(),
});

export const ActiveCycleSchema = z.object({
  cycleId: z.string().uuid(),
  updatedAt: z.date(),
});

export type Cycle = z.infer<typeof CycleSchema>;
export type ActiveCycle = z.infer<typeof ActiveCycleSchema>;
