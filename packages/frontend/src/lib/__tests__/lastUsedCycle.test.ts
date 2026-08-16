import { afterEach, describe, expect, it } from "vitest";
import { getLastUsedCycleId, setLastUsedCycleId } from "../lastUsedCycle.js";

describe("lastUsedCycle (run-cycles-spec.md §5.1 CONFIRM-1, locked) — browser-local, not server state", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns undefined when nothing has ever been set", () => {
    expect(getLastUsedCycleId()).toBeUndefined();
  });

  it("set then get round-trips the cycle id", () => {
    setLastUsedCycleId("11111111-1111-4111-8111-111111111111");
    expect(getLastUsedCycleId()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("setting a second time overwrites the first — only the most recent selection is remembered", () => {
    setLastUsedCycleId("11111111-1111-4111-8111-111111111111");
    setLastUsedCycleId("22222222-2222-4222-8222-222222222222");
    expect(getLastUsedCycleId()).toBe("22222222-2222-4222-8222-222222222222");
  });

  it(
    "is stored in window.localStorage directly, not some other client-side mechanism — real assertion " +
      "against the storage itself, not just the helper's own round-trip",
    () => {
      setLastUsedCycleId("33333333-3333-4333-8333-333333333333");
      const rawKeys = Object.keys(window.localStorage);
      const matchingKey = rawKeys.find((key) => window.localStorage.getItem(key) === "33333333-3333-4333-8333-333333333333");
      expect(matchingKey).toBeDefined();
    },
  );
});
