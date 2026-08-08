import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createExplorerRun,
  createRun,
  getFinding,
  getRunDetail,
  getTargetStats,
  listRuns,
  reproDownloadUrl,
  submitFindingFeedback,
} from "../apiClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("apiClient (frontend-spec §3)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createRun posts to /runs and parses { runId, status }", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: "run-1", status: "PENDING" }, 202));

    const result = await createRun({ charter: "test the locations flow", targetBaseUrl: "https://dev.example" });

    expect(result).toEqual({ runId: "run-1", status: "PENDING" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      charter: "test the locations flow",
      targetBaseUrl: "https://dev.example",
    });
  });

  it("createRun rejects an invalid targetBaseUrl before making any request", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await expect(createRun({ charter: "x", targetBaseUrl: "not-a-url" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("listRuns parses a paginated { runs, total } page, reviving date fields, and sends limit/offset", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        runs: [
          {
            id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
            charter: "test the locations flow",
            targetBaseUrl: "https://dev.example",
            status: "COMPLETED",
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:01:00.000Z",
            stepsUsed: 2,
            llmCallsUsed: 0,
            costUsd: 0,
          },
        ],
        total: 42,
      }),
    );

    const page = await listRuns({ limit: 25, offset: 0 });

    expect(page.total).toBe(42);
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]?.startedAt).toBeInstanceOf(Date);
    expect(page.runs[0]?.startedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/runs?limit=25&offset=0");
  });

  it("getRunDetail throws ApiError with the backend's error message on a non-OK response", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ error: "run not found" }, 404));

    await expect(getRunDetail("missing")).rejects.toThrow("run not found");
    await expect(getRunDetail("missing")).rejects.toBeInstanceOf(ApiError);
  });

  it("getRunDetail parses a D1-D7 run (testRun: null) with its findings, reviving date fields", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        charter: "test the locations flow",
        targetBaseUrl: "https://dev.example",
        status: "COMPLETED",
        startedAt: "2026-01-01T00:00:00.000Z",
        stepsUsed: 2,
        llmCallsUsed: 0,
        costUsd: 0,
        testRun: null,
        findings: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            runId: "run-1",
            screenId: "screen-1",
            type: "CONSOLE_ERROR",
            evidence: { consoleMessages: ["boom"] },
            dedupKey: "dedup-1",
            status: "NEW",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const detail = await getRunDetail("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d");

    expect(detail.testRun).toBeNull();
    expect(detail.findings).toHaveLength(1);
    expect(detail.findings[0]?.createdAt).toBeInstanceOf(Date);
    expect(detail.startedAt).toBeInstanceOf(Date);
  });

  it("getRunDetail parses a D8 run's TestRun (research/testPlan/checkOutcomes), reviving nested date fields", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        charter: 'explorer: locations — "the locations flow"',
        targetBaseUrl: "https://dev.example",
        status: "COMPLETED",
        startedAt: "2026-01-01T00:00:00.000Z",
        stepsUsed: 2,
        llmCallsUsed: 2,
        costUsd: 0.01,
        testRun: {
          id: "22222222-2222-4222-8222-222222222222",
          featureId: "locations",
          runId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
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
        findings: [],
      }),
    );

    const detail = await getRunDetail("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d");

    expect(detail.testRun?.featureId).toBe("locations");
    expect(detail.testRun?.research.capturedAt).toBeInstanceOf(Date);
    expect(detail.testRun?.startedAt).toBeInstanceOf(Date);
  });

  it("createExplorerRun posts to /explorer/runs and parses { runId, status }", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: "run-2", status: "PENDING" }, 202));

    const result = await createExplorerRun({
      featureId: "locations",
      sectionDescription: "the locations flow",
      targetBaseUrl: "https://dev.example",
    });

    expect(result).toEqual({ runId: "run-2", status: "PENDING" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/explorer/runs");
    expect(init.method).toBe("POST");
  });

  it("submitFindingFeedback posts { verdict } to /findings/:id/feedback", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await submitFindingFeedback("finding-1", "dismiss");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/findings/finding-1/feedback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ verdict: "dismiss" });
  });

  it("submitFindingFeedback throws ApiError with the backend's error message on a 400", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'verdict "confirmed_issue" requires a featureId' }, 400));

    await expect(submitFindingFeedback("finding-1", "confirmed_issue")).rejects.toThrow(/featureId/);
  });

  it("getFinding parses a single Finding", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "11111111-1111-4111-8111-111111111111",
        runId: "run-1",
        screenId: "screen-1",
        type: "STATE_DIVERGENCE",
        verdict: "REGRESSION",
        severity: "HIGH",
        reasoning: "button removed",
        confidence: 0.9,
        evidence: { ariaSnapshot: '- heading "Locations"' },
        dedupKey: "dedup-1",
        status: "NEW",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const finding = await getFinding("11111111-1111-4111-8111-111111111111");
    expect(finding.verdict).toBe("REGRESSION");
  });

  it("reproDownloadUrl builds the repro endpoint URL", () => {
    expect(reproDownloadUrl("finding-1")).toContain("/findings/finding-1/repro");
  });

  it("getTargetStats URL-encodes targetBaseUrl as a query param and parses the aggregate shape", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ newCount: 3, suppressedCount: 1, agree: 2, disagree: 0 }));

    const stats = await getTargetStats("https://dev.example/path?a=b");

    expect(stats).toEqual({ newCount: 3, suppressedCount: 1, agree: 2, disagree: 0 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/findings/stats?targetBaseUrl=");
    expect(url).toContain(encodeURIComponent("https://dev.example/path?a=b"));
  });
});
