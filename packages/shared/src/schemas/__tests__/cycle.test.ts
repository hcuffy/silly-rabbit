import { describe, expect, it } from "vitest";
import { ActiveCycleSchema, CycleSchema } from "../cycle.js";

describe("CycleSchema (run-cycles-spec.md §3)", () => {
  const base = {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    name: "Release 3.22",
    kind: "release" as const,
    status: "active" as const,
    runCounter: 0,
    sessionReplayRunCounter: 0,
    createdAt: new Date(),
  };

  it("parses a valid active cycle, defaulting isDefault to false when omitted", () => {
    const result = CycleSchema.parse(base);
    expect(result.isDefault).toBe(false);
    expect(result.archivedAt).toBeUndefined();
  });

  it("parses an archived cycle with archivedAt set", () => {
    const result = CycleSchema.parse({ ...base, status: "archived", archivedAt: new Date() });
    expect(result.status).toBe("archived");
    expect(result.archivedAt).toBeInstanceOf(Date);
  });

  it("accepts kind: 'sprint' | 'release'", () => {
    for (const kind of ["sprint", "release"] as const) {
      const result = CycleSchema.parse({ ...base, kind });
      expect(result.kind).toBe(kind);
    }
  });

  it("accepts an explicit isDefault: true (the seeded Uncategorized cycle's shape)", () => {
    const result = CycleSchema.parse({ ...base, name: "Uncategorized", isDefault: true });
    expect(result.isDefault).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(() => CycleSchema.parse({ ...base, status: "deleted" })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => CycleSchema.parse({ ...base, kind: "milestone" })).toThrow();
  });

  it("rejects a negative runCounter/sessionReplayRunCounter", () => {
    expect(() => CycleSchema.parse({ ...base, runCounter: -1 })).toThrow();
    expect(() => CycleSchema.parse({ ...base, sessionReplayRunCounter: -1 })).toThrow();
  });
});

describe("ActiveCycleSchema", () => {
  it("parses a valid pointer", () => {
    const result = ActiveCycleSchema.parse({
      cycleId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      updatedAt: new Date(),
    });
    expect(result.cycleId).toBe("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d");
  });

  it("rejects a non-uuid cycleId", () => {
    expect(() => ActiveCycleSchema.parse({ cycleId: "not-a-uuid", updatedAt: new Date() })).toThrow();
  });
});
