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

describe("RunDetail polling (frontend-spec §4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    "polls a RUNNING run every 2s and stops once it goes COMPLETED",
    async () => {
      let callCount = 0;
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("/findings/stats")) {
          return Promise.resolve(jsonResponse({ newCount: 0, suppressedCount: 0, agree: 0, disagree: 0 }));
        }
        callCount += 1;
        return Promise.resolve(jsonResponse(makeRunDetail({ status: callCount === 1 ? "RUNNING" : "COMPLETED" })));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderWithClient(<RunDetail runId={RUN_ID} />);

      expect(await screen.findByText("RUNNING")).toBeInTheDocument();
      expect(callCount).toBe(1);

      expect(await screen.findByText("COMPLETED", {}, { timeout: 4000 })).toBeInTheDocument();
      expect(callCount).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(callCount).toBe(2);
    },
    10_000,
  );
});

describe("RunDetail — D8 TestRun section (D8 dashboard)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the TestRun section when the run is D8-originated (testRun present)", async () => {
    stubFetchWithRunDetail({
      testRun: {
        id: "22222222-2222-4222-8222-222222222222",
        featureId: "locations",
        runId: RUN_ID,
        research: {
          featureId: "locations",
          sectionUrl: "https://dev.example/locations",
          sectionHeading: "Locations",
          detectedLanguage: "en",
          elements: [],
          entityFields: [],
          ariaSnapshotMasked: "",
          capturedAt: "2026-01-01T00:00:00.000Z",
        },
        testPlan: [],
        checkOutcomes: [],
        findingIds: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "COMPLETED",
      },
    });

    renderWithClient(<RunDetail runId={RUN_ID} />);

    expect(await screen.findByText("Research: Locations")).toBeInTheDocument();
  });

  it("does not render the TestRun section for a D1-D7 run (testRun: null)", async () => {
    stubFetchWithRunDetail();

    renderWithClient(<RunDetail runId={RUN_ID} />);

    await screen.findByText("Findings");
    expect(screen.queryByText(/^Research:/)).not.toBeInTheDocument();
  });

  it("shows the triage keyboard hint and finding cards when findings are present", async () => {
    stubFetchWithRunDetail({
      findings: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "BEHAVIOR_CHECK_FAILED",
          featureId: "locations",
          evidence: {},
          dedupKey: "dedup-1",
          status: "NEW",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    renderWithClient(<RunDetail runId={RUN_ID} />);

    expect(await screen.findByText("BEHAVIOR_CHECK_FAILED")).toBeInTheDocument();
    expect(screen.getByText(/Keyboard:/)).toBeInTheDocument();
  });

  it("shows the run history list's own computed number in the header when provided (reused via " +
    "navigation state, not recomputed)", async () => {
    stubFetchWithRunDetail();

    renderWithClient(<RunDetail runId={RUN_ID} runNumber={4} />);

    expect(await screen.findByText("Run detail #4")).toBeInTheDocument();
    expect(screen.getByText(RUN_ID.slice(0, 8))).toBeInTheDocument();
  });

  it("falls back to a plain header, no stray '#', when reached without a run number (direct URL/" +
    "deep link — a real, disclosed limitation, not silently wrong)", async () => {
    stubFetchWithRunDetail();

    renderWithClient(<RunDetail runId={RUN_ID} />);

    expect(await screen.findByText("Run detail")).toBeInTheDocument();
    expect(screen.queryByText(/Run detail #/)).not.toBeInTheDocument();
  });
});

describe("RunDetail — cycle-scoped header (run-cycles-spec.md §9), the real fragility fix", () => {
  const CYCLE_ID = "33333333-3333-4333-8333-333333333333";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchWithCycledRunDetail(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/findings/stats")) {
          return Promise.resolve(jsonResponse({ newCount: 0, suppressedCount: 0, agree: 0, disagree: 0 }));
        }
        if (url.includes(`/cycles/${CYCLE_ID}`)) {
          return Promise.resolve(
            jsonResponse({
              id: CYCLE_ID,
              name: "Release 3.22",
              kind: "release",
              status: "active",
              isDefault: false,
              runCounter: 2,
              sessionReplayRunCounter: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          );
        }
        return Promise.resolve(jsonResponse(makeRunDetail({ cycleId: CYCLE_ID, cycleRunNumber: 2 })));
      }),
    );
  }

  it("a cycled run reached WITHOUT a navigation-state runNumber (the direct-link/refresh case that used " +
    "to break) still shows the correct cycle-scoped number — read straight off the persisted Run record, " +
    "not dependent on how the page was reached", async () => {
    stubFetchWithCycledRunDetail();

    renderWithClient(<RunDetail runId={RUN_ID} />);

    expect(await screen.findByText("Release 3.22, Run 2")).toBeInTheDocument();
    expect(screen.queryByText(/^Run detail/)).not.toBeInTheDocument();
  });

  it("a cycled run reached WITH a (now-irrelevant) navigation-state runNumber still prefers the " +
    "persisted cycle-scoped number over the flat nav-state one", async () => {
    stubFetchWithCycledRunDetail();

    renderWithClient(<RunDetail runId={RUN_ID} runNumber={99} />);

    expect(await screen.findByText("Release 3.22, Run 2")).toBeInTheDocument();
    expect(screen.queryByText(/#99/)).not.toBeInTheDocument();
  });
});
