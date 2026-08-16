import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  deleteFinding,
  deleteRunCascade,
  deleteSessionRecordingCascade,
  deleteSessionReplayRunCascade,
  previewRunCascade,
  previewSessionRecordingCascade,
  previewSessionReplayRunCascade,
} from "./cascadeDelete.js";
import { cancelExplorerRun } from "./explorerRunLifecycle.js";
import type { McpToolDeps } from "./mcpTools.js";
import { cancelRun } from "./orchestrator.js";
import { cancelSessionReplayRun } from "./sessionReplayRunLifecycle.js";

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function progressSuffix(status: string, stepsSoFar: number): string {
  return status === "RUNNING" ? `, ${stepsSoFar} step(s) so far` : "";
}

export function registerMcpCancelDeleteTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "cancel_run",
    {
      title: "Cancel a charter-scripted run",
      description: "Cancel a PENDING or RUNNING D1-D7 run by id. Only stops execution — no historical data is touched.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      if (await cancelRun(runId, deps)) {
        return jsonResult({ cancelled: true });
      }
      const run = await deps.runRepo.get(runId);
      if (!run) {
        return errorResult("run not found");
      }
      return errorResult(`run is already ${run.status}, cannot cancel`);
    },
  );

  server.registerTool(
    "cancel_explorer_run",
    {
      title: "Cancel an explorer (D8) run",
      description: "Cancel a PENDING or RUNNING D8 run by id. Only stops execution — no historical data is touched.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      if (await cancelExplorerRun(runId, deps)) {
        return jsonResult({ cancelled: true });
      }
      const run = await deps.runRepo.get(runId);
      if (!run) {
        return errorResult("run not found");
      }
      return errorResult(`run is already ${run.status}, cannot cancel`);
    },
  );

  server.registerTool(
    "cancel_session_replay_run",
    {
      title: "Cancel a session-replay run",
      description: "Cancel a PENDING or RUNNING session-replay run by id. Only stops execution — no historical data is touched.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      if (await cancelSessionReplayRun(runId, deps)) {
        return jsonResult({ cancelled: true });
      }
      const run = await deps.sessionReplayRunRepo.get(runId);
      if (!run) {
        return errorResult("session-replay run not found");
      }
      return errorResult(`run is already ${run.status}, cannot cancel`);
    },
  );

  server.registerTool(
    "delete_run",
    {
      title: "Delete a charter-scripted run",
      description:
        "Permanently delete a D1-D7 Run, cascading to its Findings. Call without force first " +
        "to preview the blast radius; call again with force:true to confirm.",
      inputSchema: { runId: z.string(), force: z.boolean().optional() },
    },
    async ({ runId, force }) => {
      const run = await deps.runRepo.get(runId);
      if (!run) {
        return errorResult("run not found");
      }
      if (!force) {
        const preview = await previewRunCascade(runId, deps);
        return errorResult(
          `This will permanently delete Run ${runId} (currently ${run.status}${progressSuffix(run.status, run.stepsUsed)}) ` +
            `and cascade to ${preview.findingCount} finding(s) (${preview.findingsWithScreenshots} with screenshots)` +
            `${preview.hasTestRun ? " and 1 TestRun" : ""}. Call again with force:true to confirm.`,
        );
      }
      await cancelRun(runId, deps);
      const result = await deleteRunCascade(runId, deps);
      return jsonResult({ deleted: true, cascaded: result });
    },
  );

  server.registerTool(
    "delete_explorer_run",
    {
      title: "Delete an explorer (D8) run",
      description:
        "Permanently delete a D8 run, cascading to its TestRun and Findings. Call without force " +
        "first to preview the blast radius; call again with force:true to confirm.",
      inputSchema: { runId: z.string(), force: z.boolean().optional() },
    },
    async ({ runId, force }) => {
      const run = await deps.runRepo.get(runId);
      if (!run) {
        return errorResult("run not found");
      }
      if (!force) {
        const preview = await previewRunCascade(runId, deps);
        return errorResult(
          `This will permanently delete explorer run ${runId} (currently ${run.status}${progressSuffix(run.status, run.stepsUsed)}) ` +
            `and cascade to ${preview.findingCount} finding(s) (${preview.findingsWithScreenshots} with screenshots)` +
            `${preview.hasTestRun ? " and 1 TestRun" : ""}. Call again with force:true to confirm.`,
        );
      }
      await cancelExplorerRun(runId, deps);
      const result = await deleteRunCascade(runId, deps);
      return jsonResult({ deleted: true, cascaded: result });
    },
  );

  server.registerTool(
    "delete_session_replay_run",
    {
      title: "Delete a session-replay run",
      description:
        "Permanently delete a SessionReplayRun, cascading to its Findings. Call without force " +
        "first to preview the blast radius; call again with force:true to confirm.",
      inputSchema: { runId: z.string(), force: z.boolean().optional() },
    },
    async ({ runId, force }) => {
      const run = await deps.sessionReplayRunRepo.get(runId);
      if (!run) {
        return errorResult("session-replay run not found");
      }
      if (!force) {
        const preview = await previewSessionReplayRunCascade(runId, deps);
        const progress = progressSuffix(run.status, run.summary.stepsExecuted);
        return errorResult(
          `This will permanently delete session-replay run ${runId} (currently ${run.status}${progress}) ` +
            `and cascade to ${preview.findingCount} finding(s) (${preview.findingsWithScreenshots} with screenshots). ` +
            `Call again with force:true to confirm.`,
        );
      }
      await cancelSessionReplayRun(runId, deps);
      const result = await deleteSessionReplayRunCascade(runId, deps);
      return jsonResult({ deleted: true, cascaded: result });
    },
  );

  server.registerTool(
    "delete_session_recording",
    {
      title: "Delete a recorded session",
      description:
        "Permanently delete a SessionRecording, cascading to every SessionReplayRun made from it " +
        "and their Findings. Call without force first to preview the blast radius; call again with force:true to confirm.",
      inputSchema: { sessionId: z.string().uuid(), force: z.boolean().optional() },
    },
    async ({ sessionId, force }) => {
      const recording = await deps.sessionRecordingRepo.get(sessionId);
      if (!recording) {
        return errorResult("session recording not found");
      }
      if (!force) {
        const preview = await previewSessionRecordingCascade(sessionId, deps);
        return errorResult(
          `This will permanently delete session recording ${sessionId} and cascade to ` +
            `${preview.sessionReplayRunCount} session-replay run(s) and ${preview.findingCount} finding(s). ` +
            `Call again with force:true to confirm.`,
        );
      }
      const replayRuns = await deps.sessionReplayRunRepo.findBySessionId(sessionId);
      await Promise.all(replayRuns.map((run) => cancelSessionReplayRun(run.id, deps)));

      const result = await deleteSessionRecordingCascade(sessionId, deps);
      return jsonResult({ deleted: true, cascaded: result });
    },
  );

  server.registerTool(
    "delete_finding",
    {
      title: "Delete a finding",
      description:
        "Permanently delete a Finding — distinct from submit_finding_feedback's dismiss, which " +
        "is reversible. Call without force first to preview; call again with force:true to confirm.",
      inputSchema: { findingId: z.string(), force: z.boolean().optional() },
    },
    async ({ findingId, force }) => {
      const finding = await deps.findingRepo.get(findingId);
      if (!finding) {
        return errorResult("finding not found");
      }
      if (!force) {
        const hasScreenshot = finding.screenshotPath !== undefined || finding.beforeScreenshotPath !== undefined;
        return errorResult(
          `This will permanently delete finding ${findingId}${hasScreenshot ? " (has screenshot(s) on disk)" : ""}. ` +
            `Call again with force:true to confirm.`,
        );
      }
      await deleteFinding(finding, deps.findingRepo);
      return jsonResult({ deleted: true });
    },
  );
}
