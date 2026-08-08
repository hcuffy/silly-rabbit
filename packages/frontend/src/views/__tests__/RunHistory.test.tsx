import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { RunHistory } from "../RunHistory.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeRun(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    charter: "test the locations flow",
    targetBaseUrl: "https://dev.example",
    status: "COMPLETED",
    startedAt: "2026-01-01T00:00:00.000Z",
    stepsUsed: 1,
    llmCallsUsed: 0,
    costUsd: 0,
    ...overrides,
  };
}

function renderRouted() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RunHistory />} />
          <Route path="/runs/:id" element={<p>navigated to run detail</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const RUN_A = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const RUN_B = "1a2b3c4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

describe("RunHistory keyboard reachability (RunHistory keyboard-accessibility fix, preserved through the routing migration)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubTwoRuns(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ runs: [makeRun(RUN_A), makeRun(RUN_B)], total: 2 }))),
    );
  }

  async function findDataRows(): Promise<HTMLElement[]> {
    const rows = await screen.findAllByRole("row");
    return rows.filter((row) => row.getAttribute("tabindex") === "0");
  }

  it("rows are focusable via Tab, in document order (each row's own Copy button is the next stop, then the next row)", async () => {
    stubTwoRuns();
    const user = userEvent.setup();
    renderRouted();

    const dataRows = await findDataRows();
    expect(dataRows.every((row) => row.getAttribute("tabindex") === "0")).toBe(true);

    const copyButtons = await screen.findAllByRole("button", { name: "Copy full run ID" });

    await user.tab();
    expect(dataRows[0]).toHaveFocus();
    await user.tab();
    expect(copyButtons[0]).toHaveFocus();
    await user.tab();
    expect(dataRows[1]).toHaveFocus();
    await user.tab();
    expect(copyButtons[1]).toHaveFocus();
  });

  it("Enter on a focused row navigates to /runs/:id, same as a click would", async () => {
    stubTwoRuns();
    const user = userEvent.setup();
    renderRouted();

    const dataRows = await findDataRows();
    dataRows[0]?.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("navigated to run detail")).toBeInTheDocument();
  });

  it("Space on a focused row navigates to /runs/:id, same as a click would", async () => {
    stubTwoRuns();
    const user = userEvent.setup();
    renderRouted();

    const dataRows = await findDataRows();
    dataRows[1]?.focus();
    await user.keyboard(" ");

    expect(await screen.findByText("navigated to run detail")).toBeInTheDocument();
  });

  it("clicking a row navigates to /runs/:id", async () => {
    stubTwoRuns();
    const user = userEvent.setup();
    renderRouted();

    const dataRows = await findDataRows();
    await user.click(dataRows[0] as HTMLElement);

    expect(await screen.findByText("navigated to run detail")).toBeInTheDocument();
  });

  it("pressing Enter on the nested Copy button does not also navigate (keydown bubbling guard)", async () => {
    stubTwoRuns();
    const user = userEvent.setup();
    renderRouted();

    const copyButton = (await screen.findAllByRole("button", { name: "Copy full run ID" }))[0];
    copyButton?.focus();
    await user.keyboard("{Enter}");

    expect(screen.queryByText("navigated to run detail")).not.toBeInTheDocument();
  });
});

describe("RunHistory — list restructuring (run-number, date-grouping, pagination)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a global run-number continuing from the page offset, not resetting per page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const offset = new URL(url).searchParams.get("offset");
        if (offset === "25") {
          return Promise.resolve(jsonResponse({ runs: [makeRun(RUN_B)], total: 26 }));
        }
        return Promise.resolve(jsonResponse({ runs: [makeRun(RUN_A)], total: 26 }));
      }),
    );

    const user = userEvent.setup();
    const { container } = renderRouted();

    await screen.findByText("test the locations flow");
    expect(container.querySelector(".run-history__number")?.textContent).toBe("1");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(container.querySelector(".run-history__number")?.textContent).toBe("26"));
  });

  it("groups runs under a day header, and the header spans the full row width", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            runs: [
              makeRun(RUN_A, { startedAt: new Date().toISOString() }),
              makeRun(RUN_B, { startedAt: "2020-01-01T00:00:00.000Z" }),
            ],
            total: 2,
          }),
        ),
      ),
    );

    renderRouted();

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(await screen.findByText("Jan 1, 2020")).toBeInTheDocument();
  });

  it("disables Previous on the first page and Next on the last page", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ runs: [makeRun(RUN_A)], total: 1 }))));

    renderRouted();

    expect(await screen.findByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

describe("RunHistory — ?cycleId= filtering (run-cycles-spec.md §4.2's overview-card links)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderRoutedWithSearch(search: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/${search}`]}>
          <Routes>
            <Route path="/" element={<RunHistory />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("a ?cycleId= in the URL is forwarded to GET /runs as a real query parameter", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
      Promise.resolve(jsonResponse({ runs: [makeRun(RUN_A)], total: 1 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderRoutedWithSearch("?cycleId=33333333-3333-4333-8333-333333333333");
    await screen.findByText("test the locations flow");

    const [url] = fetchMock.mock.calls[0]!;
    expect(new URL(url).searchParams.get("cycleId")).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("no ?cycleId= in the URL means GET /runs is called without one — unfiltered history stays " +
    "byte-identical to today", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
      Promise.resolve(jsonResponse({ runs: [makeRun(RUN_A)], total: 1 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderRoutedWithSearch("");
    await screen.findByText("test the locations flow");

    const [url] = fetchMock.mock.calls[0]!;
    expect(new URL(url).searchParams.has("cycleId")).toBe(false);
  });
});
