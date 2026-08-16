import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RunCapacityError, startRun } from "./orchestrator.js";
import { startExplorerRun } from "./explorerRunLifecycle.js";
import { registerSessionReplayAndFindingTools } from "./mcpSessionReplayTools.js";
import { errorResult, resolveExplicitProfileOverrides, type McpToolDeps } from "./mcpProfileResolution.js";

export type { McpToolDeps } from "./mcpProfileResolution.js";

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const listPaginationInputSchema = {
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
};

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function registerMcpTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "trigger_charter_run",
    {
      title: "Trigger charter-scripted run",
      description:
        "Start a D1-D7 charter-scripted exploratory check against a target. Returns immediately; " +
        "poll get_charter_run with the returned runId. Pass profileId to use a saved target " +
        "profile's baseUrl/login/allowedDomains; targetBaseUrl is then optional and, if provided " +
        "anyway, overrides the profile's baseUrl. cycleId optionally attaches this run to a cycle.",
      inputSchema: {
        charter: z.string(),
        targetBaseUrl: z.string().url().optional(),
        profileId: z.string().uuid().optional(),
        cycleId: z.string().uuid().optional(),
      },
    },
    async (arguments_) => {
      const resolution = await resolveExplicitProfileOverrides(deps, arguments_.profileId);
      if (!resolution.ok) {
        return resolution.result;
      }

      const targetBaseUrl = arguments_.targetBaseUrl ?? resolution.overrides?.baseUrl;
      if (!targetBaseUrl) {
        return errorResult("targetBaseUrl is required (directly, or via a profileId whose profile has a baseUrl)");
      }

      const effectiveDeps = resolution.overrides
        ? {
            ...deps,
            loginCreds: resolution.overrides.loginCreds,
            allowedDomains: resolution.overrides.allowedDomains,
            charterNav: resolution.overrides.charterNav,
          }
        : deps;

      try {
        const run = await startRun({ charter: arguments_.charter, targetBaseUrl, cycleId: arguments_.cycleId }, effectiveDeps);
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
    "get_charter_run",
    {
      title: "Get charter run result",
      description: "Fetch a charter-scripted run's current status and findings by runId.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const run = await deps.runRepo.get(runId);
      if (!run) {
        return errorResult("run not found");
      }
      const findings = await deps.findingRepo.listByRun(runId);
      return jsonResult({ ...run, findings });
    },
  );

  server.registerTool(
    "trigger_explorer_run",
    {
      title: "Trigger explorer (D8) run",
      description:
        "Start a D8 feature-description-driven exploratory run against a target. Returns immediately; " +
        "poll get_explorer_run with the returned runId. Pass profileId to use a saved target " +
        "profile's baseUrl/login/allowedDomains; targetBaseUrl is then optional and, if provided " +
        "anyway, overrides the profile's baseUrl. cycleId optionally attaches this run to a cycle.",
      inputSchema: {
        featureId: z.string(),
        sectionDescription: z.string(),
        targetBaseUrl: z.string().url().optional(),
        profileId: z.string().uuid().optional(),
        cycleId: z.string().uuid().optional(),
      },
    },
    async (arguments_) => {
      const resolution = await resolveExplicitProfileOverrides(deps, arguments_.profileId);
      if (!resolution.ok) {
        return resolution.result;
      }

      const targetBaseUrl = arguments_.targetBaseUrl ?? resolution.overrides?.baseUrl;
      if (!targetBaseUrl) {
        return errorResult("targetBaseUrl is required (directly, or via a profileId whose profile has a baseUrl)");
      }

      const effectiveDeps = resolution.overrides
        ? {
            ...deps,
            loginCreds: resolution.overrides.loginCreds,
            allowedDomains: resolution.overrides.allowedDomains,
            charterNav: resolution.overrides.charterNav,
          }
        : deps;

      try {
        const run = await startExplorerRun(
          { featureId: arguments_.featureId, sectionDescription: arguments_.sectionDescription, targetBaseUrl, cycleId: arguments_.cycleId },
          effectiveDeps,
        );
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
    "get_explorer_run",
    {
      title: "Get explorer run result",
      description: "Fetch a D8 explorer run's current status, research/test-plan detail, and findings by runId.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => {
      const run = await deps.runRepo.get(runId);
      if (!run) {
        return errorResult("run not found");
      }
      const [testRun, findings] = await Promise.all([deps.testRunRepo.getByRunId(run.id), deps.findingRepo.listByRun(run.id)]);
      return jsonResult({ ...run, testRun, findings });
    },
  );

  server.registerTool(
    "list_explorer_runs",
    {
      title: "List explorer (D8) runs",
      description: "List D8 explorer runs, most recent first.",
      inputSchema: listPaginationInputSchema,
    },
    async ({ limit, offset }) => jsonResult(await deps.testRunRepo.list({ limit: limit ?? DEFAULT_LIST_LIMIT, offset: offset ?? 0 })),
  );

  registerSessionReplayAndFindingTools(server, deps);
}
