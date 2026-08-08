import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceDiff } from "../EvidenceDiff.js";

describe("EvidenceDiff", () => {
  it("marks changed lines as added/removed and leaves unchanged lines plain", () => {
    const { container } = render(
      <EvidenceDiff before={'- heading "Locations" [level=1]\n- text "5 items"'} after={'- heading "Locations" [level=1]\n- text "7 items"'} />,
    );

    const removed = container.querySelectorAll(".evidence-diff__line--removed");
    const added = container.querySelectorAll(".evidence-diff__line--added");
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0]?.textContent).toContain("5 items");
    expect(added[0]?.textContent).toContain("7 items");

    const plainLines = container.querySelectorAll(".evidence-diff__line:not(.evidence-diff__line--added):not(.evidence-diff__line--removed)");
    expect(plainLines.length).toBeGreaterThan(0);
    expect([...plainLines].some((line) => line.textContent?.includes("Locations"))).toBe(true);
  });

  it("renders no added/removed lines when before and after are identical", () => {
    const { container } = render(<EvidenceDiff before='- heading "Locations"' after='- heading "Locations"' />);
    expect(container.querySelectorAll(".evidence-diff__line--added")).toHaveLength(0);
    expect(container.querySelectorAll(".evidence-diff__line--removed")).toHaveLength(0);
  });
});
