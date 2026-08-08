import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FieldHint } from "../FieldHint.js";

describe("FieldHint (real-tooltip fix — bare `title` never rendered anything on real hover, confirmed empirically)", () => {
  it("carries the tooltip text as both the accessible name and the CSS-rendered data attribute", () => {
    render(<FieldHint text="Example tooltip content" />);

    const hint = screen.getByLabelText("Example tooltip content");
    expect(hint).toHaveAttribute("data-tooltip", "Example tooltip content");
    expect(hint).toHaveAttribute("tabindex", "0");
    expect(hint).not.toHaveAttribute("title");
  });
});
