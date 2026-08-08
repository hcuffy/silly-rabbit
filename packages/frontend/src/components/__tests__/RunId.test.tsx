import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunId } from "../RunId.js";

const FULL_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

describe("RunId", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the first 8 characters, with the full id available via the title attribute", () => {
    render(<RunId id={FULL_ID} />);
    expect(screen.getByText("9b1deb4d")).toBeInTheDocument();
    expect(screen.getByText("9b1deb4d").closest(".run-id")).toHaveAttribute("title", FULL_ID);
  });

  it("copies the full id to the clipboard on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<RunId id={FULL_ID} />);
    await userEvent.click(screen.getByRole("button", { name: /copy full run id/i }));

    expect(writeText).toHaveBeenCalledWith(FULL_ID);
  });

  it("shows transient 'Copied!' feedback after a successful copy, then reverts to 'Copy' (live-review fix)", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<RunId id={FULL_ID} />);
    const button = screen.getByRole("button", { name: /copy full run id/i });
    expect(button).toHaveTextContent("Copy");

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(button).toHaveTextContent("Copied!");

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(button).toHaveTextContent("Copy");
  });
});
