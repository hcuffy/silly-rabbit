import { describe, expect, it } from "vitest";
import type { Finding } from "../../schemas/finding.js";
import { computeFindingStats } from "../findingStats.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    runId: "run-1",
    screenId: "screen-1",
    type: "STATE_DIVERGENCE",
    evidence: {},
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("computeFindingStats", () => {
  it("counts NEW and RECURRING separately, ignores RESOLVED/DISMISSED", () => {
    const findings = [
      makeFinding({ status: "NEW" }),
      makeFinding({ status: "NEW" }),
      makeFinding({ status: "RECURRING" }),
      makeFinding({ status: "RESOLVED" }),
      makeFinding({ status: "DISMISSED" }),
    ];
    expect(computeFindingStats(findings)).toEqual({ newCount: 2, suppressedCount: 1 });
  });

  it("returns zeros for an empty list", () => {
    expect(computeFindingStats([])).toEqual({ newCount: 0, suppressedCount: 0 });
  });
});
