import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { recordFeedback } from "@silly-rabbit/explorer";
import { z } from "zod";
import { RunCapacityError } from "./orchestrator.js";
import { findingResult } from "./mcpFindingResult.js";
import { errorResult, resolveExplicitProfileOverrides, type McpToolDeps } from "./mcpProfileResolution.js";
import { startSessionReplayRun } from "./sessionReplayRunLifecycle.js";

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const listPaginationInputSchema = {
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
};

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function registerSessionReplayAndFindingTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "trigger_session_replay_run",
    {
      title: "Trigger session-replay run",
      description:
        "Replay a previously-recorded session (see list_session_recordings) against its target. " +
        "Returns immediately; poll get_session_replay_run with the returned runId. Pass profileId " +
        "to use a saved target profile's allowedDomains for this replay (baseUrl/login aren't " +
        "relevant here — the recording already carries its own target). cycleId optionally attaches this run to a cycle.",
      inputSchema: {
        sessionId: z.string().uuid(),
        replayMode: z.enum(["live", "mocked"]).optional(),
        profileId: z.string().uuid().optional(),
        cycleId: z.string().uuid().optional(),
      },
    },
    async (arguments_) => {
      const resolution = await resolveExplicitProfileOverrides(deps, arguments_.profileId);
      if (!resolution.ok) {
        return resolution.result;
      }

      const effectiveDeps = resolution.overrides ? { ...deps, allowedDomains: resolution.overrides.allowedDomains } : deps;

      try {
        const run = await startSessionReplayRun(
          { sessionId: arguments_.sessionId, replayMode: arguments_.replayMode, cycleId: arguments_.cycleId },
          effectiveDeps,
        );
        if (!run) {
          return errorResult("session recording not found");
        }
        return jsonResult({ runId: run.id, status: run.status });
      } catch (error) {
        if (error instanceof RunCapacityError) {
          return errorResult(error.message);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_session_replay_run",
    {
      title: "Get session-replay run result",
      description: "Fetch a session-replay run's current status, step list, and findings by runId.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const run = await deps.sessionReplayRunRepo.get(runId);
      if (!run) {
        return errorResult("session-replay run not found");
      }
      const [findings, sessionRecording] = await Promise.all([deps.findingRepo.findByRunIds([run.id]), deps.sessionRecordingRepo.get(run.sessionId)]);
      return jsonResult({ ...run, findings, steps: sessionRecording?.steps ?? [] });
    },
  );

  server.registerTool(
    "list_session_replay_runs",
    {
      title: "List session-replay runs",
      description: "List session-replay runs, most recent first.",
      inputSchema: listPaginationInputSchema,
    },
    async ({ limit, offset }) => jsonResult(await deps.sessionReplayRunRepo.list({ limit: limit ?? DEFAULT_LIST_LIMIT, offset: offset ?? 0 })),
  );

  server.registerTool(
    "list_session_recordings",
    {
      title: "List recorded sessions",
      description: "List every recorded session available to replay (see trigger_session_replay_run).",
      inputSchema: {},
    },
    async () => jsonResult(await deps.sessionRecordingRepo.list()),
  );

  server.registerTool(
    "get_finding",
    {
      title: "Get a finding",
      description: "Fetch a single Finding by id, including its screenshot(s) as image content when available.",
      inputSchema: { findingId: z.string() },
    },
    async ({ findingId }) => {
      const finding = await deps.findingRepo.get(findingId);
      if (!finding) {
        return errorResult("finding not found");
      }
      return findingResult(finding);
    },
  );

  server.registerTool(
    "submit_finding_feedback",
    {
      title: "Submit feedback on a finding",
      description: "Mark a finding as confirmed_issue, intended_behavior (explorer/D8 findings only), or dismiss.",
      inputSchema: {
        findingId: z.string(),
        verdict: z.enum(["confirmed_issue", "intended_behavior", "dismiss"]),
      },
    },
    async ({ findingId, verdict }) => {
      const finding = await deps.findingRepo.get(findingId);
      if (!finding) {
        return errorResult("finding not found");
      }
      if (verdict !== "dismiss" && !finding.featureId) {
        return errorResult(
          `verdict "${verdict}" requires the finding to have a featureId (only set for explorer/D8 findings); this finding has none`,
        );
      }
      await recordFeedback({ finding, featureId: finding.featureId ?? "", verdict }, deps.learningRepo, deps.findingRepo);
      return jsonResult({ ok: true });
    },
  );
}
