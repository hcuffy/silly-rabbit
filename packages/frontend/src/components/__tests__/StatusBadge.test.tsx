import type { Run } from "@silly-rabbit/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "../StatusBadge.js";

describe("StatusBadge (dashboard redesign — status routes to a tint via className)", () => {
  it.each<Run["status"]>(["PENDING", "RUNNING", "COMPLETED", "FAILED"])("renders the status text inside a status-badge--%s class", (status) => {
    render(<StatusBadge status={status} />);
    const badge = screen.getByText(status);
    expect(badge).toHaveClass("status-badge", `status-badge--${status.toLowerCase()}`);
  });
});
