import { describe, expect, it } from "vitest";
import { SessionReplayRunSchema, SessionReplayRunSummarySchema } from "../sessionReplayRun.js";

describe("SessionReplayRunSummarySchema", () => {
  it("parses a valid summary", () => {
    const result = SessionReplayRunSummarySchema.parse({ stepsExecuted: 2, stepsDrifted: 1, stepsErrored: 0 });
    expect(result).toEqual({ stepsExecuted: 2, stepsDrifted: 1, stepsErrored: 0 });
  });

  it("rejects a negative count", () => {
    expect(() => SessionReplayRunSummarySchema.parse({ stepsExecuted: -1, stepsDrifted: 0, stepsErrored: 0 })).toThrow();
  });
});

describe("SessionReplayRunSchema (session-replay-spec §8.2)", () => {
  const base = {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    sessionId: "c1a2b3c4-1111-4bad-9bdd-2b0d7b3dcb6d",
    replayMode: "live" as const,
    status: "PENDING" as const,
    startedAt: new Date(),
    summary: { stepsExecuted: 0, stepsDrifted: 0, stepsErrored: 0 },
  };

  it("parses a valid run with completedAt omitted (not completed yet)", () => {
    const result = SessionReplayRunSchema.parse(base);
    expect(result.completedAt).toBeUndefined();
    expect(result.status).toBe("PENDING");
  });

  it("parses a completed run with completedAt set", () => {
    const result = SessionReplayRunSchema.parse({
      ...base,
      status: "COMPLETED",
      completedAt: new Date(),
      summary: { stepsExecuted: 3, stepsDrifted: 0, stepsErrored: 0 },
    });
    expect(result.completedAt).toBeInstanceOf(Date);
  });

  it("parses a failed run with an error message", () => {
    const result = SessionReplayRunSchema.parse({ ...base, status: "FAILED", error: "browser launch failed" });
    expect(result.error).toBe("browser launch failed");
  });

  it("accepts replayMode: 'live' | 'mocked'", () => {
    for (const replayMode of ["live", "mocked"] as const) {
      const result = SessionReplayRunSchema.parse({ ...base, replayMode });
      expect(result.replayMode).toBe(replayMode);
    }
  });

  it("rejects a non-uuid sessionId", () => {
    expect(() => SessionReplayRunSchema.parse({ ...base, sessionId: "not-a-uuid" })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => SessionReplayRunSchema.parse({ ...base, status: "DONE" })).toThrow();
  });

  it("rejects a missing summary", () => {
    expect(() =>
      SessionReplayRunSchema.parse({
        id: base.id,
        sessionId: base.sessionId,
        replayMode: base.replayMode,
        status: base.status,
        startedAt: base.startedAt,
      }),
    ).toThrow();
  });
});
