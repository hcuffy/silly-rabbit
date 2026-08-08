import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { App } from "../App.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const RUN_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const FINDING_A = "11111111-1111-4111-8111-111111111111";
const FINDING_B = "22222222-2222-4222-8222-222222222222";

function makeRunListEntry() {
  return {
    id: RUN_ID,
    charter: "test the locations flow",
    targetBaseUrl: "https://dev.example",
    status: "COMPLETED",
    startedAt: new Date().toISOString(),
    stepsUsed: 1,
    llmCallsUsed: 0,
    costUsd: 0,
  };
}

function makeFinding(id: string, featureId: string | undefined) {
  return {
    id,
    runId: RUN_ID,
    screenId: "screen-1",
    type: "BEHAVIOR_CHECK_FAILED",
    featureId,
    evidence: {},
    dedupKey: `dedup-${id}`,
    status: "NEW",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeRunDetail() {
  return { ...makeRunListEntry(), testRun: null, findings: [makeFinding(FINDING_A, "locations"), makeFinding(FINDING_B, "locations")] };
}

describe("Triage shortcuts survive the react-router migration — reached via real navigation, not a direct render", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBackend(): { feedbackCalls: { findingId: string; verdict: string }[] } {
    const feedbackCalls: { findingId: string; verdict: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.includes("/auth/session")) return Promise.resolve(new Response(null, { status: 200 }));
        if (url.includes("/findings/stats")) {
          return Promise.resolve(jsonResponse({ newCount: 0, suppressedCount: 0, agree: 0, disagree: 0 }));
        }
        if (url.includes("/feedback")) {
          const match = /\/findings\/([^/]+)\/feedback/.exec(url);
          const { verdict } = JSON.parse(init?.body as string) as { verdict: string };
          feedbackCalls.push({ findingId: match?.[1] ?? "unknown", verdict });
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.includes("/explorer/runs/")) return Promise.resolve(jsonResponse(makeRunDetail()));
        if (url.endsWith("/runs") || url.includes("/runs?")) {
          return Promise.resolve(jsonResponse({ runs: [makeRunListEntry()], total: 1 }));
        }
        return Promise.resolve(jsonResponse({ error: `unexpected url in test: ${url}` }, 500));
      }),
    );
    return { feedbackCalls };
  }

  function renderApp() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("Enter navigates from the run list to a run's detail page, then 1/2/3/N/P all still work there", async () => {
    const { feedbackCalls } = stubBackend();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("link", { name: "Run history" }));

    await screen.findByText("test the locations flow");
    const dataRow = (await screen.findAllByRole("row")).find((row) => row.getAttribute("tabindex") === "0");
    dataRow?.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText(/Run detail/)).toBeInTheDocument();
    expect(await screen.findAllByText("BEHAVIOR_CHECK_FAILED")).toHaveLength(2);

    await user.keyboard("3");
    expect(feedbackCalls).toContainEqual({ findingId: FINDING_A, verdict: "dismiss" });

    await user.keyboard("N");
    await user.keyboard("1");
    expect(feedbackCalls).toContainEqual({ findingId: FINDING_B, verdict: "confirmed_issue" });

    await user.keyboard("P");
    await user.keyboard("2");
    expect(feedbackCalls).toContainEqual({ findingId: FINDING_A, verdict: "intended_behavior" });
  });
});
