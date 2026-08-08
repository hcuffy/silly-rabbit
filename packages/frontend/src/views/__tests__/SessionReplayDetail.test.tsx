import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionReplayDetail } from "../SessionReplayDetail.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const RUN_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

function makeRunDetail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    sessionId: "1a2b3c4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    replayMode: "live",
    status: "COMPLETED",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    summary: { stepsExecuted: 2, stepsDrifted: 0, stepsErrored: 0 },
    findings: [],
    steps: [
      { action: "navigate", selectorStrategy: "css", value: "https://dev.example", timestampOffsetMs: 0 },
      { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 500 },
    ],
    ...overrides,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function stubFetchWithRunDetail(overrides: Partial<Record<string, unknown>> = {}) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(makeRunDetail(overrides)))));
}

describe("SessionReplayDetail (dashboard-integration slice 2, session-replay-spec §8.2/§8.3 " +
  "CONFIRM-9, resolved — dedicated component, not forced into RunDetail/TestRunSection)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders status/replayMode/summary/step list", async () => {
    stubFetchWithRunDetail();
    renderWithClient(<SessionReplayDetail runId={RUN_ID} />);

    expect(await screen.findByText("COMPLETED")).toBeInTheDocument();
    expect(screen.getByText(/mode: live/)).toBeInTheDocument();
    expect(screen.getByText("2 executed · 0 drifted · 0 errored")).toBeInTheDocument();
    expect(screen.getByText('Navigate to https://dev.example')).toBeInTheDocument();
    expect(screen.getByText('Click "Save"')).toBeInTheDocument();
  });

  it("shows the run-level error when status is FAILED", async () => {
    stubFetchWithRunDetail({ status: "FAILED", error: "browser launch failed", completedAt: "2026-01-01T00:01:00.000Z" });
    renderWithClient(<SessionReplayDetail runId={RUN_ID} />);

    expect(await screen.findByText("FAILED")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("browser launch failed");
  });

  it("a step with an associated Finding: the Finding renders via the existing FindingCard badge " +
    "treatment (CONFIRM-9 — no new status-indicator component built)", async () => {
    stubFetchWithRunDetail({
      summary: { stepsExecuted: 1, stepsDrifted: 1, stepsErrored: 0 },
      findings: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          runId: RUN_ID,
          screenId: "screen-1",
          type: "BEHAVIOR_CHECK_FAILED",
          origin: "session-replay",
          verdict: "NEEDS_HUMAN",
          severity: "LOW",
          evidence: {},
          dedupKey: "dedup-1",
          status: "NEW",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    renderWithClient(<SessionReplayDetail runId={RUN_ID} />);

    expect(await screen.findByText("BEHAVIOR_CHECK_FAILED")).toBeInTheDocument();
    expect(screen.getByText("NEEDS_HUMAN")).toBeInTheDocument();
    expect(screen.getByText("LOW")).toBeInTheDocument();
  });

  it("a run with no findings shows 'No findings yet.' — a step with no Finding renders plainly, no badge", async () => {
    stubFetchWithRunDetail();
    renderWithClient(<SessionReplayDetail runId={RUN_ID} />);

    await screen.findByText("2 executed · 0 drifted · 0 errored");
    expect(screen.getByText("No findings yet.")).toBeInTheDocument();
    expect(screen.queryByText("BEHAVIOR_CHECK_FAILED")).not.toBeInTheDocument();
  });

  it("an uncycled run keeps today's exact bare header — no new fallback invented (run-cycles-spec.md " +
    "§9: D9 never had a flat scheme, so there is nothing to fall back to)", async () => {
    stubFetchWithRunDetail();
    renderWithClient(<SessionReplayDetail runId={RUN_ID} />);

    expect(await screen.findByText("Session replay detail")).toBeInTheDocument();
  });
});

describe("SessionReplayDetail — cycle-scoped header (run-cycles-spec.md §9), new display, not a retrofit", () => {
  const CYCLE_ID = "44444444-4444-4444-8444-444444444444";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a cycled replay run shows '{cycle.name}, Replay N' — the first numbering treatment D9 has ever had", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes(`/cycles/${CYCLE_ID}`)) {
          return Promise.resolve(
            jsonResponse({
              id: CYCLE_ID,
              name: "Sprint 14",
              kind: "sprint",
              status: "active",
              isDefault: false,
              runCounter: 0,
              sessionReplayRunCounter: 3,
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          );
        }
        return Promise.resolve(jsonResponse(makeRunDetail({ cycleId: CYCLE_ID, replayRunNumber: 3 })));
      }),
    );

    renderWithClient(<SessionReplayDetail runId={RUN_ID} />);

    expect(await screen.findByText("Sprint 14, Replay 3")).toBeInTheDocument();
    expect(screen.queryByText("Session replay detail")).not.toBeInTheDocument();
  });
});
