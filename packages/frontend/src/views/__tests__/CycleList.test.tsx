import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CycleList } from "../CycleList.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const DEFAULT_CYCLE = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "Uncategorized",
  kind: "release",
  status: "active",
  isDefault: true,
  runCounter: 0,
  sessionReplayRunCounter: 0,
  createdAt: new Date().toISOString(),
};

const RELEASE_CYCLE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Release 3.22",
  kind: "release",
  status: "active",
  isDefault: false,
  runCounter: 2,
  sessionReplayRunCounter: 1,
  createdAt: new Date().toISOString(),
};

const ARCHIVED_CYCLE = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Sprint 1",
  kind: "sprint",
  status: "archived",
  isDefault: false,
  runCounter: 5,
  sessionReplayRunCounter: 0,
  createdAt: new Date().toISOString(),
  archivedAt: new Date().toISOString(),
};

function statsFor(cycle: typeof RELEASE_CYCLE) {
  return { runCount: cycle.runCounter, replayRunCount: cycle.sessionReplayRunCounter, newCount: 0, suppressedCount: 0, agree: 0, disagree: 0 };
}

describe("CycleList (run-cycles-spec.md §4 — cycle management + overview, one unified page)", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>;

  function makeFetchMock() {
    return vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/archive")) {
        const id = url.split("/").at(-2);
        if (id === DEFAULT_CYCLE.id) {
          return Promise.resolve(jsonResponse({ error: "the Uncategorized cycle cannot be archived" }, 409));
        }
        return Promise.resolve(jsonResponse({ ...ARCHIVED_CYCLE, id }));
      }
      if (init?.method === "POST" && url.endsWith("/activate")) return Promise.resolve(new Response(null, { status: 204 }));
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ ...RELEASE_CYCLE, name: "New Cycle" }, 201));
      if (url.includes("/cycles/active")) return Promise.resolve(jsonResponse({ cycleId: RELEASE_CYCLE.id }));
      if (url.includes(`/cycles/${DEFAULT_CYCLE.id}/stats`)) return Promise.resolve(jsonResponse(statsFor(DEFAULT_CYCLE)));
      if (url.includes(`/cycles/${RELEASE_CYCLE.id}/stats`)) return Promise.resolve(jsonResponse(statsFor(RELEASE_CYCLE)));
      if (url.includes(`/cycles/${ARCHIVED_CYCLE.id}/stats`)) return Promise.resolve(jsonResponse(statsFor(ARCHIVED_CYCLE)));
      if (url.endsWith("/cycles")) return Promise.resolve(jsonResponse([DEFAULT_CYCLE, RELEASE_CYCLE, ARCHIVED_CYCLE]));
      return Promise.resolve(jsonResponse({ error: `unexpected url in test: ${url}` }, 500));
    });
  }

  beforeEach(() => {
    fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists active cycles with stats, the active pointer badge, and archived cycles separately, " +
    "de-emphasized", async () => {
    renderWithClient(<CycleList />);

    expect(await screen.findByText("Release 3.22")).toBeInTheDocument();
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    expect(await screen.findByText("2 run(s) · 1 replay run(s) · 0 new · 0 suppressed")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();

    expect(await screen.findByText("Sprint 1")).toBeInTheDocument();
    expect(screen.getByText("Archived cycles").closest("section")).toContainElement(screen.getByText("Sprint 1"));
  });

  it("archiving a normal cycle asks for confirmation and calls the archive route", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    const user = userEvent.setup();
    renderWithClient(<CycleList />);
    await screen.findByText("Release 3.22");

    const releaseCard = screen.getByText("Release 3.22").closest(".cycle-card") as HTMLElement;
    await user.click(within(releaseCard).getByRole("button", { name: "Archive" }));

    expect(confirmMock).toHaveBeenCalled();
  });

  it("the Uncategorized (isDefault) card never shows an Archive button at all", async () => {
    renderWithClient(<CycleList />);
    await screen.findByText("Uncategorized");

    const defaultCard = screen.getByText("Uncategorized").closest(".cycle-card") as HTMLElement;
    expect(within(defaultCard).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("the '+ New cycle' trigger uses the shared .button system, not a plain unstyled button", async () => {
    renderWithClient(<CycleList />);
    await screen.findByText("Release 3.22");

    expect(screen.getByRole("button", { name: "+ New cycle" })).toHaveClass("button", "button--secondary");
  });

  it("the cycle-create form marks Name and Kind required (real, non-optional fields per CycleWriteInputSchema)", async () => {
    const user = userEvent.setup();
    renderWithClient(<CycleList />);
    await screen.findByText("Release 3.22");

    await user.click(screen.getByRole("button", { name: "+ New cycle" }));

    expect(screen.getByLabelText("Name")).toBeRequired();
    expect(screen.getByLabelText("Kind")).toBeRequired();
  });

  it("creating a cycle shows the form, then hides it again on success", async () => {
    const user = userEvent.setup();
    renderWithClient(<CycleList />);
    await screen.findByText("Release 3.22");

    await user.click(screen.getByRole("button", { name: "+ New cycle" }));
    expect(screen.getByRole("heading", { name: "New cycle" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "Release 3.23");
    await user.click(screen.getByRole("button", { name: "Create cycle" }));

    expect(await screen.findByRole("button", { name: "+ New cycle" })).toBeInTheDocument();
  });

  it("activating a cycle calls the activate route", async () => {
    const user = userEvent.setup();
    renderWithClient(<CycleList />);
    await screen.findByText("Uncategorized");

    const defaultCard = screen.getByText("Uncategorized").closest(".cycle-card") as HTMLElement;
    await user.click(within(defaultCard).getByRole("button", { name: "Set active" }));

    expect(
      fetchMock.mock.calls.some(([url, init]) => init?.method === "POST" && url.includes("/activate")),
    ).toBe(true);
  });
});
