const STORAGE_KEY = "silly-rabbit:last-used-cycle-id";

export function getLastUsedCycleId(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setLastUsedCycleId(cycleId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, cycleId);
  } catch {
    /* empty */
  }
}
