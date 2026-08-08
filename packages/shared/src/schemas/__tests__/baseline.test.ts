import { describe, expect, it } from "vitest";
import { BaselineSchema } from "../baseline.js";

describe("BaselineSchema", () => {
  it("parses a valid baseline", () => {
    const result = BaselineSchema.parse({
      screenId: "screen-1",
      fingerprint: "sha256:abc123",
      ariaSnapshotMasked: "heading: Bookings",
      capturedAt: new Date(),
      runId: "run-1",
    });
    expect(result.screenId).toBe("screen-1");
  });

  it("rejects a baseline missing required fields", () => {
    expect(() =>
      BaselineSchema.parse({
        screenId: "screen-1",
        capturedAt: new Date(),
        runId: "run-1",
      }),
    ).toThrow();
  });

  it("parses an old baseline with no baselineScreenshotPath field (additive, backward-compatible)", () => {
    const result = BaselineSchema.parse({
      screenId: "screen-1",
      fingerprint: "sha256:abc123",
      ariaSnapshotMasked: "heading: Bookings",
      capturedAt: new Date(),
      runId: "run-1",
    });
    expect(result.baselineScreenshotPath).toBeUndefined();
  });

  it("accepts baselineScreenshotPath", () => {
    const result = BaselineSchema.parse({
      screenId: "screen-1",
      fingerprint: "sha256:abc123",
      ariaSnapshotMasked: "heading: Bookings",
      capturedAt: new Date(),
      runId: "run-1",
      baselineScreenshotPath: "/tmp/screenshots/baseline-screen-1.png",
    });
    expect(result.baselineScreenshotPath).toBe("/tmp/screenshots/baseline-screen-1.png");
  });
});
