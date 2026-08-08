import type { FeatureDocument, TestRun } from "@silly-rabbit/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestRunSection } from "../TestRunSection.js";

function makeTestRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    featureId: "locations",
    runId: "run-1",
    research: {
      featureId: "locations",
      sectionUrl: "https://dev.example/locations",
      sectionHeading: "Locations",
      detectedLanguage: "en",
      elements: [{ kind: "input", accessibleName: "Name", role: "textbox", required: true }],
      entityFields: ["Name"],
      ariaSnapshotMasked: "",
      capturedAt: new Date("2026-01-01T00:00:00Z"),
    },
    testPlan: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        featureId: "locations",
        assumption: "the name field is required",
        happyPathCheck: {
          description: "Submit a valid location",
          action: "submit",
          expectedOutcome: "the location appears in the table",
        },
        boundaryCheck: {
          description: "Submit with an empty name",
          action: "submit",
          expectedOutcome: "a validation error is shown",
          category: "empty_required",
        },
      },
    ],
    checkOutcomes: [
      { hypothesisId: "33333333-3333-4333-8333-333333333333", check: "happy", result: "passed" },
      { hypothesisId: "33333333-3333-4333-8333-333333333333", check: "boundary", result: "failed" },
    ],
    findingIds: [],
    startedAt: new Date("2026-01-01T00:00:00Z"),
    status: "COMPLETED",
    ...overrides,
  };
}

function makeFeatureDocument(overrides: Partial<FeatureDocument> = {}): FeatureDocument {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    featureId: "locations",
    generatedAt: new Date("2026-01-01T00:00:00Z"),
    sourceTestRunId: "22222222-2222-4222-8222-222222222222",
    activeLearningIds: [],
    content: "# Locations\n\nThis feature lists locations.",
    model: "claude-sonnet-4-6",
    llmCallsUsed: 1,
    costUsd: 0.01,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("TestRunSection (D8 dashboard — research collapsed, plan/outcomes visible)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the research summary inside a collapsed <details>", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([]))));
    renderWithClient(<TestRunSection testRun={makeTestRun()} />);

    const details = screen.getByText("Research: Locations").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
  });

  it("renders the test plan (assumption + happy-path + boundary check) without needing expansion", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([]))));
    renderWithClient(<TestRunSection testRun={makeTestRun()} />);

    expect(screen.getAllByText("the name field is required").length).toBeGreaterThan(0);
    expect(screen.getByText(/Submit a valid location/)).toBeInTheDocument();
    expect(screen.getByText(/Submit with an empty name/)).toBeInTheDocument();
  });

  it("renders check-outcome counts and per-hypothesis results without needing expansion", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([]))));
    renderWithClient(<TestRunSection testRun={makeTestRun()} />);

    expect(screen.getByText(/Passed: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Failed: 1/)).toBeInTheDocument();
    expect(screen.getByText("passed")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  describe("feature doc section (feature-docs-spec §5)", () => {
    it("shows 'no feature doc generated yet' when history is empty", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([]))));
      renderWithClient(<TestRunSection testRun={makeTestRun()} />);

      expect(await screen.findByText("No feature doc generated yet.")).toBeInTheDocument();
    });

    it("renders the latest doc's content and metadata when history exists", async () => {
      const featureDocument = makeFeatureDocument();
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([featureDocument]))));
      renderWithClient(<TestRunSection testRun={makeTestRun()} />);

      expect(await screen.findByText(/This feature lists locations/)).toBeInTheDocument();
      expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
    });

    it("shows a history list only when more than one generation exists", async () => {
      const older = makeFeatureDocument({ generatedAt: new Date("2026-01-01T00:00:00Z") });
      const newer = makeFeatureDocument({ generatedAt: new Date("2026-01-02T00:00:00Z") });
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse([newer, older]))));
      renderWithClient(<TestRunSection testRun={makeTestRun()} />);

      expect(await screen.findByText("History (2)")).toBeInTheDocument();
    });

    it("clicking 'Generate feature doc' POSTs to the featureId's docs route and refreshes history", async () => {
      const user = userEvent.setup();
      const generatedDocument = makeFeatureDocument({ content: "freshly generated content" });
      let generated = false;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          generated = true;
          return Promise.resolve(jsonResponse(generatedDocument));
        }
        return Promise.resolve(jsonResponse(generated ? [generatedDocument] : []));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderWithClient(<TestRunSection testRun={makeTestRun()} />);
      await screen.findByText("No feature doc generated yet.");

      await user.click(screen.getByText("Generate feature doc"));

      expect(await screen.findByText("freshly generated content")).toBeInTheDocument();
      const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(postCall?.[0]).toContain("/features/locations/docs");
    });

    it("shows the mutation's error message when generation fails", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        if (init?.method === "POST") return Promise.resolve(jsonResponse({ error: "wait before regenerating" }, 429));
        return Promise.resolve(jsonResponse([]));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderWithClient(<TestRunSection testRun={makeTestRun()} />);
      await screen.findByText("No feature doc generated yet.");

      await user.click(screen.getByText("Generate feature doc"));

      await waitFor(() => expect(screen.getByText("wait before regenerating")).toBeInTheDocument());
    });
  });
});
