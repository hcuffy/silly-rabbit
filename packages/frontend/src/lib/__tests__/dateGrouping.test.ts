import type { Run } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { formatDayGroupLabel, groupRunsByDay } from "../dateGrouping.js";

const NOW = new Date(2026, 6, 26, 12, 0, 0);

function makeRun(startedAt: Date, overrides: Partial<Run> = {}): Run {
  return {
    id: `${startedAt.toISOString()}-${Math.random()}`,
    charter: "x",
    targetBaseUrl: "https://dev.example",
    status: "COMPLETED",
    startedAt,
    stepsUsed: 0,
    llmCallsUsed: 0,
    costUsd: 0,
    ...overrides,
  };
}

describe("formatDayGroupLabel", () => {
  it("labels today as 'Today'", () => {
    expect(formatDayGroupLabel(new Date(2026, 6, 26, 8, 0), NOW)).toBe("Today");
  });

  it("labels yesterday as 'Yesterday'", () => {
    expect(formatDayGroupLabel(new Date(2026, 6, 25, 23, 59), NOW)).toBe("Yesterday");
  });

  it("labels an earlier same-year date as 'Mon D'", () => {
    expect(formatDayGroupLabel(new Date(2026, 5, 1, 10, 0), NOW)).toBe("Jun 1");
  });

  it("labels a prior-year date with the year included", () => {
    expect(formatDayGroupLabel(new Date(2025, 11, 31, 10, 0), NOW)).toBe("Dec 31, 2025");
  });
});

describe("groupRunsByDay", () => {
  it("groups consecutive same-day runs into one bucket, in input order", () => {
    const runs = [makeRun(new Date(2026, 6, 26, 9, 0)), makeRun(new Date(2026, 6, 26, 8, 0)), makeRun(new Date(2026, 6, 25, 20, 0))];
    const groups = groupRunsByDay(runs, NOW);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.label).toBe("Today");
    expect(groups[0]?.runs).toHaveLength(2);
    expect(groups[1]?.label).toBe("Yesterday");
    expect(groups[1]?.runs).toHaveLength(1);
  });

  it("starts a new group for a day split across a non-contiguous run list (page-boundary safe)", () => {
    const runs = [makeRun(new Date(2026, 6, 26, 9, 0)), makeRun(new Date(2026, 6, 25, 20, 0))];
    const groups = groupRunsByDay(runs, NOW);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday"]);
  });

  it("returns an empty array for an empty run list", () => {
    expect(groupRunsByDay([], NOW)).toEqual([]);
  });
});
