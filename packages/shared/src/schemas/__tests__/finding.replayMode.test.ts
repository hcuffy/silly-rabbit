import { describe, expect, it } from "vitest";
import { FindingSchema } from "../finding.js";

describe(
  "FindingSchema.replayMode (session-replay-spec, slice 3). Split into its own file to keep " + "finding.test.ts under the 250-line lint cap.",
  () => {
    it("parses an old finding with no replayMode field (additive, backward-compatible)", () => {
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
      expect(result.replayMode).toBeUndefined();
    });

    it("accepts replayMode: 'live' | 'mocked'", () => {
      for (const replayMode of ["live", "mocked"] as const) {
        const result = FindingSchema.parse({
          id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
          runId: "run-1",
          screenId: "screen-1",
          type: "STATE_DIVERGENCE",
          origin: "session-replay",
          replayMode,
          evidence: {},
          dedupKey: "dedup-1",
          status: "NEW",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        expect(result.replayMode).toBe(replayMode);
      }
    });

    it("rejects an unknown replayMode value", () => {
      expect(() =>
        FindingSchema.parse({
          id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
          runId: "run-1",
          screenId: "screen-1",
          type: "STATE_DIVERGENCE",
          replayMode: "recorded",
          evidence: {},
          dedupKey: "dedup-1",
          status: "NEW",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ).toThrow();
    });
  },
);
