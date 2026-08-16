import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "../RunDetail.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const RUN_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

function makeRunDetail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    charter: "test the locations flow",
    targetBaseUrl: "https://dev.example",
    status: "COMPLETED",
    startedAt: "2026-01-01T00:00:00.000Z",
    stepsUsed: 1,
    llmCallsUsed: 0,
    costUsd: 0,
    testRun: null,
    findings: [],
    ...overrides,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function stubFetchWithRunDetail(overrides: Partial<Record<string, unknown>> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/findings/stats")) {
        return Promise.resolve(jsonResponse({ newCount: 0, suppressedCount: 0, agree: 0, disagree: 0 }));
      }
      return Promise.resolve(jsonResponse(makeRunDetail(overrides)));
    }),
  );
}

describe("RunDetail — new-vs-suppressed + judge-accuracy stats (dashboard-analytics-spec items 1/3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a new-vs-suppressed stat row reflecting each finding's status", async () => {
    stubFetchWithRunDetail({
      findings: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "STATE_DIVERGENCE",
          evidence: {},
          dedupKey: "dedup-1",
          status: "NEW",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "STATE_DIVERGENCE",
          evidence: {},
          dedupKey: "dedup-2",
          status: "RECURRING",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "STATE_DIVERGENCE",
          evidence: {},
          dedupKey: "dedup-3",
          status: "RESOLVED",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    renderWithClient(<RunDetail runId={RUN_ID} />);

    expect(await screen.findByText("1 new · 1 suppressed")).toBeInTheDocument();
  });

  it("shows no per-run stat row when there are no findings (the all-time target line is a separate concern, tested elsewhere)", async () => {
    stubFetchWithRunDetail();

    renderWithClient(<RunDetail runId={RUN_ID} />);

    await screen.findByText("No findings yet.");
    expect(screen.queryByText(/^\d+ new · \d+ suppressed$/)).not.toBeInTheDocument();
  });

  it("shows judge accuracy, scoped to D8 findings with feedback, with the limitation stated in copy", async () => {
    stubFetchWithRunDetail({
      findings: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "BEHAVIOR_CHECK_FAILED",
          featureId: "locations",
          verdict: "REGRESSION",
          humanVerdict: "confirmed_issue",
          evidence: {},
          dedupKey: "dedup-1",
          status: "NEW",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "BEHAVIOR_CHECK_FAILED",
          featureId: "locations",
          verdict: "REGRESSION",
          humanVerdict: "intended_behavior",
          evidence: {},
          dedupKey: "dedup-2",
          status: "NEW",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "STATE_DIVERGENCE",
          verdict: "REGRESSION",
          status: "DISMISSED",
          evidence: {},
          dedupKey: "dedup-3",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    renderWithClient(<RunDetail runId={RUN_ID} />);

    expect(await screen.findByText("Judge accuracy (D8 findings with feedback only): 1 agree · 1 disagree")).toBeInTheDocument();
  });

  it("shows no judge-accuracy row when no D8 finding has received feedback yet", async () => {
    stubFetchWithRunDetail({
      findings: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "BEHAVIOR_CHECK_FAILED",
          featureId: "locations",
          verdict: "REGRESSION",
          evidence: {},
          dedupKey: "dedup-1",
          status: "NEW",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    renderWithClient(<RunDetail runId={RUN_ID} />);

    await screen.findByText("BEHAVIOR_CHECK_FAILED");
    expect(screen.queryByText(/Judge accuracy/)).not.toBeInTheDocument();
  });
});

describe("RunDetail — all-time target stats (dashboard-analytics-spec Phase 2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the all-time new/suppressed line using GET /findings/stats?targetBaseUrl=<this run's target>", async () => {
    let capturedUrl: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/findings/stats")) {
          capturedUrl = url;
          return Promise.resolve(jsonResponse({ newCount: 4, suppressedCount: 2, agree: 0, disagree: 0 }));
        }
        return Promise.resolve(jsonResponse(makeRunDetail()));
      }),
    );

    renderWithClient(<RunDetail runId={RUN_ID} />);

    expect(await screen.findByText("Across all runs against this target: 4 new · 2 suppressed all-time")).toBeInTheDocument();
    expect(capturedUrl).toContain(encodeURIComponent("https://dev.example"));
  });

  it("shows the all-time judge-accuracy line only when something has been scored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/findings/stats")) {
          return Promise.resolve(jsonResponse({ newCount: 1, suppressedCount: 0, agree: 3, disagree: 1 }));
        }
        return Promise.resolve(jsonResponse(makeRunDetail()));
      }),
    );

    renderWithClient(<RunDetail runId={RUN_ID} />);

    expect(await screen.findByText("Judge accuracy all-time (D8 findings with feedback only): 3 agree · 1 disagree")).toBeInTheDocument();
  });

  it("hides the all-time judge-accuracy line when nothing has been scored yet", async () => {
    stubFetchWithRunDetail();

    renderWithClient(<RunDetail runId={RUN_ID} />);

    await screen.findByText("No findings yet.");
    expect(screen.queryByText(/Judge accuracy all-time/)).not.toBeInTheDocument();
  });
});
