import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult, resolveExplicitProfileOverrides, type McpToolDeps } from "./mcpProfileResolution.js";
import { buildNavMap } from "./navMapLifecycle.js";
import { RunCapacityError } from "./orchestrator.js";

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function registerMcpNavMapTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "crawl_nav_map",
    {
      title: "Crawl and persist a NavMap",
      description:
        "Synchronously crawl a target's nav structure + per-screen page structure (app-mapping-spec.md " +
        "§4/§5) and persist the result as a NavMap, one document per baseUrl. Runs to completion and " +
        "returns the built NavMap directly — not a polled Run. Pass profileId to use a saved target " +
        "profile's baseUrl/login/allowedDomains; targetBaseUrl is then optional and, if provided " +
        "anyway, overrides the profile's baseUrl.",
      inputSchema: {
        targetBaseUrl: z.string().url().optional(),
        profileId: z.string().uuid().optional(),
      },
    },
    async (arguments_) => {
      if (!deps.navMapRepo) return errorResult("NavMap is not configured on this MCP server");

      const resolution = await resolveExplicitProfileOverrides(deps, arguments_.profileId);
      if (!resolution.ok) return resolution.result;

      const targetBaseUrl = arguments_.targetBaseUrl ?? resolution.overrides?.baseUrl;
      if (!targetBaseUrl) return errorResult("targetBaseUrl is required (directly, or via a profileId whose profile has a baseUrl)");

      const effectiveDeps = resolution.overrides
        ? { ...deps, navMapRepo: deps.navMapRepo, loginCreds: resolution.overrides.loginCreds, allowedDomains: resolution.overrides.allowedDomains }
        : { ...deps, navMapRepo: deps.navMapRepo };

      try {
        return jsonResult(await buildNavMap({ baseUrl: targetBaseUrl }, effectiveDeps));
      } catch (error) {
        if (error instanceof RunCapacityError) return errorResult(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "get_nav_map",
    {
      title: "Get a target's NavMap",
      description: "Fetch the currently-persisted NavMap for a baseUrl, if one has been crawled (see crawl_nav_map).",
      inputSchema: { targetBaseUrl: z.string().url() },
    },
    async ({ targetBaseUrl }) => {
      if (!deps.navMapRepo) return errorResult("NavMap is not configured on this MCP server");

      const navMap = await deps.navMapRepo.getByBaseUrl(targetBaseUrl);
      if (!navMap) return errorResult("no nav map for this baseUrl — call crawl_nav_map first");
      return jsonResult(navMap);
    },
  );

  server.registerTool(
    "delete_nav_map",
    {
      title: "Delete a target's NavMap",
      description: "Permanently delete the persisted NavMap for a baseUrl. Nothing else references a NavMap " +
        "by id, so this is a standalone delete — no cascade. Call without force first to preview; call again " +
        "with force:true to confirm.",
      inputSchema: { targetBaseUrl: z.string().url(), force: z.boolean().optional() },
    },
    async ({ targetBaseUrl, force }) => {
      if (!deps.navMapRepo) return errorResult("NavMap is not configured on this MCP server");

      const navMap = await deps.navMapRepo.getByBaseUrl(targetBaseUrl);
      if (!navMap) return errorResult("no nav map for this baseUrl");
      if (!force) {
        return errorResult(
          `This will permanently delete the NavMap for ${targetBaseUrl} (${navMap.entries.length} entries). ` +
            `Call again with force:true to confirm.`,
        );
      }

      await deps.navMapRepo.delete(targetBaseUrl);
      return jsonResult({ deleted: true });
    },
  );
}
