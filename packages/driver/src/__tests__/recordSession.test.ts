import type { SessionRecordingStep } from "@silly-rabbit/shared";
import { describe, expect, it, vi } from "vitest";
import { logDestructiveAttempt } from "../recordSession.js";

describe("logDestructiveAttempt (session-replay-spec §5.2 — passive logger, not a blocker)", () => {
  it("warns, does not throw, on a click matching a destructive pattern", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const step: SessionRecordingStep = {
      action: "click",
      selectorStrategy: "role",
      role: "button",
      accessibleName: "Delete location",
      timestampOffsetMs: 100,
    };

    expect(() => logDestructiveAttempt(step)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("DESTRUCTIVE ACTION CLICKED");
    warn.mockRestore();
  });

  it("does nothing for a non-destructive click", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const step: SessionRecordingStep = {
      action: "click",
      selectorStrategy: "role",
      role: "button",
      accessibleName: "Save",
      timestampOffsetMs: 100,
    };

    logDestructiveAttempt(step);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does nothing for a css-strategy click (no accessible name to evaluate)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const step: SessionRecordingStep = {
      action: "click",
      selectorStrategy: "css",
      cssSelector: "#delete-button",
      timestampOffsetMs: 100,
    };

    logDestructiveAttempt(step);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does nothing for a fill step", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const step: SessionRecordingStep = {
      action: "fill",
      selectorStrategy: "role",
      role: "textbox",
      accessibleName: "Name",
      value: "Delete",
      timestampOffsetMs: 100,
    };

    logDestructiveAttempt(step);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
