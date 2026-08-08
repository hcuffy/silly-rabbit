import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getSessionReplayRunDetail, listSessionRecordings, triggerSessionReplayRun } from "../apiClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("session-replay apiClient functions (dashboard-integration slice 2, session-replay-spec §8). " +
  "Split into its own file, apiClient.test.ts is already at the 250-line lint cap.", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("triggerSessionReplayRun posts to /session-replay/runs and parses { runId, status }", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: "replay-run-1", status: "PENDING" }, 202));

    const result = await triggerSessionReplayRun({ sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" });

    expect(result).toEqual({ runId: "replay-run-1", status: "PENDING" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/session-replay/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" });
  });

  it("triggerSessionReplayRun rejects a non-uuid sessionId before making any request", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await expect(triggerSessionReplayRun({ sessionId: "not-a-uuid" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("triggerSessionReplayRun throws ApiError with the backend's error message on a 404 " +
    "(sessionId with no matching recording)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "session recording not found" }, 404));

    await expect(triggerSessionReplayRun({ sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("getSessionReplayRunDetail parses the run, its findings, and its steps, reviving date fields", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        sessionId: "1a2b3c4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        replayMode: "live",
        status: "COMPLETED",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        summary: { stepsExecuted: 2, stepsDrifted: 0, stepsErrored: 0 },
        findings: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            runId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
            screenId: "screen-1",
            type: "STATE_DIVERGENCE",
            origin: "session-replay",
            evidence: {},
            dedupKey: "dedup-1",
            status: "NEW",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        steps: [
          { action: "navigate", selectorStrategy: "css", value: "https://dev.example", timestampOffsetMs: 0 },
          { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 500 },
        ],
      }),
    );

    const detail = await getSessionReplayRunDetail("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d");

    expect(detail.startedAt).toBeInstanceOf(Date);
    expect(detail.completedAt).toBeInstanceOf(Date);
    expect(detail.findings).toHaveLength(1);
    expect(detail.findings[0]?.createdAt).toBeInstanceOf(Date);
    expect(detail.steps).toHaveLength(2);
    expect(detail.steps[1]).toMatchObject({ action: "click", accessibleName: "Save" });
    expect(detail.summary).toEqual({ stepsExecuted: 2, stepsDrifted: 0, stepsErrored: 0 });
  });

  it("getSessionReplayRunDetail parses a run with no completedAt yet (still RUNNING)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        sessionId: "1a2b3c4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        replayMode: "live",
        status: "RUNNING",
        startedAt: "2026-01-01T00:00:00.000Z",
        summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
        findings: [],
        steps: [],
      }),
    );

    const detail = await getSessionReplayRunDetail("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d");
    expect(detail.completedAt).toBeUndefined();
    expect(detail.status).toBe("RUNNING");
  });

  it("listSessionRecordings parses an array of recordings, reviving recordedAt", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          sessionId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
          targetBaseUrl: "https://dev.example",
          recordedAt: "2026-01-01T00:00:00.000Z",
          steps: [],
        },
      ]),
    );

    const recordings = await listSessionRecordings();

    expect(recordings).toHaveLength(1);
    expect(recordings[0]?.recordedAt).toBeInstanceOf(Date);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/session-recordings");
  });
});
