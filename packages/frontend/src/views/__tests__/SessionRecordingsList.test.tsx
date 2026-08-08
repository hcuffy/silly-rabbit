import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { SessionRecordingsList } from "../SessionRecordingsList.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeRecording(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    targetBaseUrl: "https://dev.example",
    recordedAt: "2026-01-01T00:00:00.000Z",
    steps: [],
    ...overrides,
  };
}

function renderRouted() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<SessionRecordingsList />} />
          <Route path="/session-replay/:id" element={<p>navigated to session-replay detail</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SessionRecordingsList (dashboard-integration slice 2, session-replay-spec §8.3 " +
  "CONFIRM-7/CONFIRM-8, resolved)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a row per recording — sessionId, targetBaseUrl, recordedAt", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([makeRecording()]))));

    renderRouted();

    expect(await screen.findByText("https://dev.example")).toBeInTheDocument();
    expect(screen.getByText("9b1deb4d")).toBeInTheDocument();
    expect(screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("shows no filtering/search controls — plain list only (CONFIRM-7, resolved: no filtering for v1). " +
    "The per-row cycle <select> is a real combobox now (run-cycles-spec.md §5.3) — an explicit-assignment " +
    "control on the trigger action, not a filter over the recordings list, so it's excluded from this check",
  async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([makeRecording()]))));

    renderRouted();
    await screen.findByText("https://dev.example");

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("never shows a 'record new session' control (CONFIRM-8, resolved: dashboard is replay-trigger only)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([makeRecording()]))));

    renderRouted();
    await screen.findByText("https://dev.example");

    expect(screen.queryByRole("button", { name: /record/i })).not.toBeInTheDocument();
  });

  it("clicking Replay POSTs /session-replay/runs with the row's sessionId and navigates to the returned runId", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ runId: "new-replay-run", status: "PENDING" }, 202));
      return Promise.resolve(jsonResponse([makeRecording()]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderRouted();
    await user.click(await screen.findByRole("button", { name: "Replay" }));

    expect(await screen.findByText("navigated to session-replay detail")).toBeInTheDocument();
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall?.[0]).toContain("/session-replay/runs");
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({
      sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    });
  });

  it("shows a message when no recordings exist yet", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([]))));

    renderRouted();

    expect(await screen.findByText("No recorded sessions yet.")).toBeInTheDocument();
  });
});
