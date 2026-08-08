import type { Finding } from "@silly-rabbit/shared";
import { renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useTriageShortcuts } from "../useTriageShortcuts.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  const now = new Date();
  return {
    id: "11111111-1111-1111-1111-111111111111",
    runId: "run-1",
    screenId: "screen-1",
    type: "BEHAVIOR_CHECK_FAILED",
    evidence: {},
    dedupKey: "dedup-1",
    status: "NEW",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("useTriageShortcuts (D8 dashboard triage)", () => {
  it("'3' fires dismiss for the active finding regardless of featureId", async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn();
    const findings = [makeFinding({ id: "a", featureId: undefined })];
    renderHook(() =>
      useTriageShortcuts({ findings, activeIndex: 0, onNavigate: vi.fn(), onFeedback }),
    );

    await user.keyboard("3");

    expect(onFeedback).toHaveBeenCalledWith("a", "dismiss");
  });

  it("'1'/'2' fire confirmed_issue/intended_behavior only when the active finding has a featureId", async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn();
    const findings = [makeFinding({ id: "a", featureId: "locations" })];
    renderHook(() =>
      useTriageShortcuts({ findings, activeIndex: 0, onNavigate: vi.fn(), onFeedback }),
    );

    await user.keyboard("1");
    await user.keyboard("2");

    expect(onFeedback).toHaveBeenNthCalledWith(1, "a", "confirmed_issue");
    expect(onFeedback).toHaveBeenNthCalledWith(2, "a", "intended_behavior");
  });

  it("'1'/'2' are gated off (no call) when the active finding has no featureId (D1-D7-shaped finding)", async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn();
    const findings = [makeFinding({ id: "a", featureId: undefined })];
    renderHook(() =>
      useTriageShortcuts({ findings, activeIndex: 0, onNavigate: vi.fn(), onFeedback }),
    );

    await user.keyboard("1");
    await user.keyboard("2");

    expect(onFeedback).not.toHaveBeenCalled();
  });

  it("'n'/'p' navigate within bounds and do not wrap past the first/last finding", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const findings = [makeFinding({ id: "a" }), makeFinding({ id: "b" }), makeFinding({ id: "c" })];

    const { rerender } = renderHook(
      ({ activeIndex }: { activeIndex: number }) =>
        useTriageShortcuts({ findings, activeIndex, onNavigate, onFeedback: vi.fn() }),
      { initialProps: { activeIndex: 0 } },
    );

    await user.keyboard("p");
    expect(onNavigate).not.toHaveBeenCalled();

    await user.keyboard("n");
    expect(onNavigate).toHaveBeenCalledWith(1);

    rerender({ activeIndex: 2 });
    onNavigate.mockClear();
    await user.keyboard("n");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("ignores shortcuts while a text input is focused", async () => {
    const user = userEvent.setup();
    const onFeedback = vi.fn();
    const findings = [makeFinding({ id: "a" })];
    renderHook(() =>
      useTriageShortcuts({ findings, activeIndex: 0, onNavigate: vi.fn(), onFeedback }),
    );

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    await user.keyboard("3");

    expect(onFeedback).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });
});
