import { CycleSchema, type Cycle } from "@silly-rabbit/shared";
import { z } from "zod";
import { request, reviveDates } from "./apiClient.js";

const CYCLE_DATE_KEYS = ["createdAt", "archivedAt"] as const;

function parseCycle(raw: unknown): Cycle {
  return CycleSchema.parse(reviveDates(raw as Record<string, unknown>, CYCLE_DATE_KEYS));
}

export const CycleWriteInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  kind: z.enum(["sprint", "release"]),
});
export type CycleWriteInput = z.infer<typeof CycleWriteInputSchema>;

export async function listCycles(status?: "active" | "archived"): Promise<Cycle[]> {
  const statusParameter = status ? `?status=${status}` : "";
  const response = await request(`/cycles${statusParameter}`);
  const body = (await response.json()) as unknown[];
  return body.map(parseCycle);
}

export async function getCycle(id: string): Promise<Cycle> {
  const response = await request(`/cycles/${id}`);
  return parseCycle(await response.json());
}

export async function createCycle(input: CycleWriteInput): Promise<Cycle> {
  const parsedInput = CycleWriteInputSchema.parse(input);
  const response = await request("/cycles", { method: "POST", body: JSON.stringify(parsedInput) });
  return parseCycle(await response.json());
}

export async function archiveCycle(id: string): Promise<Cycle> {
  const response = await request(`/cycles/${id}/archive`, { method: "POST" });
  return parseCycle(await response.json());
}

export async function activateCycle(id: string): Promise<void> {
  await request(`/cycles/${id}/activate`, { method: "POST" });
}

export async function getActiveCycleId(): Promise<string | null> {
  const response = await request("/cycles/active");
  const body = (await response.json()) as { cycleId: string | null };
  return body.cycleId;
}

const CycleStatsResponseSchema = z.object({
  runCount: z.number(),
  replayRunCount: z.number(),
  newCount: z.number(),
  suppressedCount: z.number(),
  agree: z.number(),
  disagree: z.number(),
});
export type CycleStats = z.infer<typeof CycleStatsResponseSchema>;

export async function getCycleStats(id: string): Promise<CycleStats> {
  const response = await request(`/cycles/${id}/stats`);
  return CycleStatsResponseSchema.parse(await response.json());
}
