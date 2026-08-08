import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppShell } from "../AppShell.js";

function renderShell(): void {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<p>routed page content</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppShell — persistent rail with real nav links, collapsible", () => {
  it("renders branding, real nav links to run history, session recordings, and settings, plus the " +
    "routed content via Outlet", () => {
    renderShell();

    expect(screen.getByText("Silly Rabbit")).toBeInTheDocument();
    expect(screen.getByText("routed page content")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "New run" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Run history" })).toHaveAttribute("href", "/runs");
    expect(screen.getByRole("link", { name: "Session recordings" })).toHaveAttribute("href", "/session-recordings");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("the current route's nav link is marked aria-current, others are not", () => {
    renderShell();

    expect(screen.getByRole("link", { name: "New run" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Run history" })).not.toHaveAttribute("aria-current");
  });

  it("collapsing the sidebar hides the brand/full labels but keeps every link and the toggle reachable", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.queryByText("Silly Rabbit")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "N" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "R" })).toHaveAttribute("href", "/runs");
    expect(screen.getByRole("link", { name: "S" })).toHaveAttribute("href", "/session-recordings");
    expect(screen.getByRole("link", { name: "T" })).toHaveAttribute("href", "/settings");

    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByText("Silly Rabbit")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Run history" })).toBeInTheDocument();
  });
});
