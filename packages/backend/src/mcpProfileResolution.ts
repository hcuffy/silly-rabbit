import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TargetProfileOverrides } from "@silly-rabbit/shared";
import type { ExplorerRunLifecycleDeps } from "./explorerRunLifecycle.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import type { NavMapRepo } from "./repos/navMapRepo.js";
import type { TargetProfileRepo } from "./repos/targetProfileRepo.js";
import type { SessionReplayRunLifecycleDeps } from "./sessionReplayRunLifecycle.js";
import { resolveProfileOverridesById } from "./targetProfileResolution.js";

export type McpToolDeps = OrchestratorDeps &
  ExplorerRunLifecycleDeps &
  SessionReplayRunLifecycleDeps & {
    targetProfileRepo?: TargetProfileRepo;
    navMapRepo?: NavMapRepo;
  };

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

export type ProfileResolution = { ok: true; overrides: TargetProfileOverrides | undefined } | { ok: false; result: CallToolResult };

export async function resolveExplicitProfileOverrides(deps: McpToolDeps, profileId: string | undefined): Promise<ProfileResolution> {
  if (!profileId) {
    return { ok: true, overrides: undefined };
  }
  if (!deps.targetProfileRepo) {
    return { ok: false, result: errorResult("target profiles are not configured on this MCP server") };
  }

  try {
    return { ok: true, overrides: await resolveProfileOverridesById(deps.targetProfileRepo, profileId) };
  } catch (error) {
    return { ok: false, result: errorResult(error instanceof Error ? error.message : String(error)) };
  }
}
