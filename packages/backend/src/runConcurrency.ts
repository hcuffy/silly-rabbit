export class RunCapacityError extends Error {}

const DEFAULT_MAX_CONCURRENT_RUNS = 3;

const inFlightRuns = new Set<Promise<void>>();

export async function waitForInFlightRuns(timeoutMs: number): Promise<void> {
  if (inFlightRuns.size === 0) {
    return;
  }
  const allDone = Promise.all([...inFlightRuns]);
  await Promise.race([allDone, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

export function trackInFlightRun(job: Promise<void>): void {
  inFlightRuns.add(job);
  void job.finally(() => inFlightRuns.delete(job));
}

/**
 * Reserves a concurrency slot in the same inFlightRuns Set used for shutdown-draining, shared
 * across all 3 run types (Run/TestRun/SessionReplayRun) since they all launch a real chromium
 * instance. The reservation itself (not just the eventual job) is added synchronously, before
 * any `await`, so a burst of trigger calls fired without awaiting between them still gates
 * correctly — checking inFlightRuns.size only at the top of an async function is not enough,
 * since concurrent callers would all observe the same stale size before any of them finishes
 * its first await and registers a job.
 */
export function reserveRunSlot(maxConcurrentRuns: number | undefined): () => void {
  const cap = maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  if (inFlightRuns.size >= cap) {
    throw new RunCapacityError(
      `max concurrent runs (${cap}) reached — ${inFlightRuns.size} run(s) already in flight, wait for one to finish before starting another`,
    );
  }
  const reservation = Promise.resolve();
  inFlightRuns.add(reservation);
  return () => inFlightRuns.delete(reservation);
}
