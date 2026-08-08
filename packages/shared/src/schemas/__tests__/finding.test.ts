import { describe, expect, it } from "vitest";
import { FindingSchema } from "../finding.js";

describe("FindingSchema", () => {
  it("parses a valid finding", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "CONSOLE_ERROR",
      evidence: { consoleMessages: ["TypeError: x is undefined"] },
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.type).toBe("CONSOLE_ERROR");
  });

  it("accepts severity 'WARNING' (explorer-spec §9/§11.3 — rollback-failure findings)", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "OTHER",
      severity: "WARNING",
      evidence: {},
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.severity).toBe("WARNING");
  });

  it("accepts status 'DISMISSED' (feedback flow — recordFeedback dismiss branch)", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "OTHER",
      evidence: {},
      dedupKey: "dedup-1",
      status: "DISMISSED",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.status).toBe("DISMISSED");
  });

  it("parses an old finding whose evidence lacks ariaSnapshotBefore (additive field, backward-compatible)", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      evidence: { ariaSnapshot: "current snapshot text" },
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.evidence.ariaSnapshotBefore).toBeUndefined();
  });

  it("accepts evidence.ariaSnapshotBefore alongside ariaSnapshot", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      evidence: { ariaSnapshot: "current snapshot text", ariaSnapshotBefore: "baseline snapshot text" },
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.evidence.ariaSnapshotBefore).toBe("baseline snapshot text");
  });

  it("parses an old finding with no escalatedToOpus field (additive, backward-compatible)", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      evidence: {},
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.escalatedToOpus).toBeUndefined();
  });

  it("accepts escalatedToOpus: true", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      escalatedToOpus: true,
      evidence: {},
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.escalatedToOpus).toBe(true);
  });

  it("parses an old finding with no humanVerdict field (additive, backward-compatible)", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "BEHAVIOR_CHECK_FAILED",
      evidence: {},
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.humanVerdict).toBeUndefined();
  });

  it("accepts humanVerdict: confirmed_issue or intended_behavior", () => {
    const confirmed = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "BEHAVIOR_CHECK_FAILED",
      humanVerdict: "confirmed_issue",
      evidence: {},
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(confirmed.humanVerdict).toBe("confirmed_issue");
  });

  it("parses an old finding with no beforeScreenshotPath field (additive, backward-compatible)", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      evidence: {},
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.beforeScreenshotPath).toBeUndefined();
  });

  it("accepts beforeScreenshotPath alongside the existing screenshotPath (after)", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      beforeScreenshotPath: "/tmp/screenshots/baseline-screen-1.png",
      screenshotPath: "/tmp/screenshots/finding-1.png",
      evidence: {},
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.beforeScreenshotPath).toBe("/tmp/screenshots/baseline-screen-1.png");
    expect(result.screenshotPath).toBe("/tmp/screenshots/finding-1.png");
  });

  it("parses an old finding with no origin field (additive, backward-compatible — session-replay-spec §5.5)", () => {
    const result = FindingSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      runId: "run-1",
      screenId: "screen-1",
      type: "STATE_DIVERGENCE",
      evidence: {},
      dedupKey: "dedup-1",
      status: "NEW",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.origin).toBeUndefined();
  });

  it("accepts origin: 'charter' | 'explorer' | 'session-replay'", () => {
    for (const origin of ["charter", "explorer", "session-replay"] as const) {
      const result = FindingSchema.parse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        runId: "run-1",
        screenId: "screen-1",
        type: "STATE_DIVERGENCE",
        origin,
        evidence: {},
        dedupKey: "dedup-1",
        status: "NEW",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(result.origin).toBe(origin);
    }
  });

  it("rejects an unknown origin value", () => {
    expect(() =>
      FindingSchema.parse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        runId: "run-1",
        screenId: "screen-1",
        type: "STATE_DIVERGENCE",
        origin: "manual",
        evidence: {},
        dedupKey: "dedup-1",
        status: "NEW",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow();
  });

  it("rejects an invalid finding", () => {
    expect(() =>
      FindingSchema.parse({
        id: "not-a-uuid",
        runId: "run-1",
        screenId: "screen-1",
        type: "NOT_A_TYPE",
        evidence: {},
        dedupKey: "dedup-1",
        status: "NEW",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow();
  });
});
