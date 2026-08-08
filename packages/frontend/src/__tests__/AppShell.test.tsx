import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppShell } from "../AppShell.js";

function renderShell() {
  return render(
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

  it("renders the brand logo image alongside the brand text when expanded", () => {
    renderShell();

    const logo = screen.getByAltText("Silly Rabbit logo");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "/images/silly-rabbit-logo-detailed-1024.png");
  });

  it("collapsing the sidebar hides the brand/full text labels but keeps every link (via icon + " +
    "aria-label) and the toggle reachable", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.queryByText("Silly Rabbit")).not.toBeInTheDocument();
    expect(screen.queryByAltText("Silly Rabbit logo")).not.toBeInTheDocument();
    // Collapsed nav links keep their full accessible name via aria-label — only the visible text node
    // disappears (replaced by an icon), so the same real name-based queries still resolve each link.
    expect(screen.getByRole("link", { name: "New run" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Run history" })).toHaveAttribute("href", "/runs");
    expect(screen.getByRole("link", { name: "Session recordings" })).toHaveAttribute("href", "/session-recordings");
    expect(screen.getByRole("link", { name: "Cycles" })).toHaveAttribute("href", "/cycles");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");

    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByText("Silly Rabbit")).toBeInTheDocument();
    expect(screen.getByAltText("Silly Rabbit logo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Run history" })).toBeInTheDocument();
  });

  it("every nav link renders an icon in both expanded and collapsed states", async () => {
    const user = userEvent.setup();
    const { container } = renderShell();

    expect(container.querySelectorAll(".app-shell__link svg")).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(container.querySelectorAll(".app-shell__link svg")).toHaveLength(5);
  });
});
