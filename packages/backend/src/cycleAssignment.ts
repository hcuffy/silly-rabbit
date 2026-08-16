import type { CycleRepo } from "./repos/cycleRepo.js";

export async function resolveRunCycleFields(
  cycleId: string | undefined,
  cycleRepo: CycleRepo | undefined,
): Promise<{ cycleId?: string; cycleRunNumber?: number }> {
  if (!cycleId || !cycleRepo) {
    return {};
  }
  const cycleRunNumber = await cycleRepo.incrementAndGetRunNumber(cycleId);
  return cycleRunNumber === undefined ? {} : { cycleId, cycleRunNumber };
}

export async function resolveSessionReplayRunCycleFields(
  cycleId: string | undefined,
  cycleRepo: CycleRepo | undefined,
): Promise<{ cycleId?: string; replayRunNumber?: number }> {
  if (!cycleId || !cycleRepo) {
    return {};
  }
  const replayRunNumber = await cycleRepo.incrementAndGetSessionReplayRunNumber(cycleId);
  return replayRunNumber === undefined ? {} : { cycleId, replayRunNumber };
}
