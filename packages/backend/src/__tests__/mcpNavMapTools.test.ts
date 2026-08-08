import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { registerMcpNavMapTools } from "../mcpNavMapTools.js";
import type { McpToolDeps } from "../mcpProfileResolution.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { NavMapRepo } from "../repos/navMapRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const NAV_MAP_ORIGIN = "https://mcp-nav-map.example.com";

function throwingJudgeClient(): AnthropicLike {
  return { messages: { create: () => { throw new Error("judge should not be called by a NavMap crawl"); } } };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content[0];
  return block?.text ? JSON.parse(block.text) : undefined;
}

async function installRoutes(context: BrowserContext): Promise<void> {
  await context.route(`${NAV_MAP_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<html><body><a href="/">Home</a></body></html>` }),
  );
}

describe("MCP delete_nav_map tool", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let client: Client;
  let navMapRepo: NavMapRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-navmap-repro-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-navmap-screenshot-"));

    navMapRepo = new NavMapRepo(connection.db);
    const deps: McpToolDeps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      sessionRecordingRepo: new SessionRecordingRepo(connection.db),
      sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      navMapRepo,
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: [new URL(NAV_MAP_ORIGIN).host],
      productionUrlPatterns: [],
      installRoutes,
    };

    const server = new McpServer({ name: "silly-rabbit-test", version: "1.0.0" });
    registerMcpNavMapTools(server, deps);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  }, 30_000);

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("without force: previews the blast radius and does not delete", async () => {
    await client.callTool({ name: "crawl_nav_map", arguments: { targetBaseUrl: NAV_MAP_ORIGIN } });

    const result = await client.callTool({ name: "delete_nav_map", arguments: { targetBaseUrl: NAV_MAP_ORIGIN } });
    expect(result.isError).toBe(true);
    const body = textOf(result as never) as { error: string };
    expect(body.error).toContain(NAV_MAP_ORIGIN);
    expect(body.error).toContain("force:true");

    expect(await navMapRepo.getByBaseUrl(NAV_MAP_ORIGIN)).not.toBeNull();
  });

  it("with force:true: really deletes — a second get_nav_map call finds nothing, not a stale/cached hit", async () => {
    const beforeDelete = await navMapRepo.getByBaseUrl(NAV_MAP_ORIGIN);
    expect(beforeDelete).not.toBeNull();

    const result = await client.callTool({ name: "delete_nav_map", arguments: { targetBaseUrl: NAV_MAP_ORIGIN, force: true } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as never)).toEqual({ deleted: true });

    expect(await navMapRepo.getByBaseUrl(NAV_MAP_ORIGIN)).toBeNull();

    const getResult = await client.callTool({ name: "get_nav_map", arguments: { targetBaseUrl: NAV_MAP_ORIGIN } });
    expect(getResult.isError).toBe(true);
  });

  it("deleting a baseUrl with no NavMap is a clear error, not a silent success", async () => {
    const result = await client.callTool({
      name: "delete_nav_map",
      arguments: { targetBaseUrl: "https://never-crawled-mcp.example.com" },
    });
    expect(result.isError).toBe(true);
    const body = textOf(result as never) as { error: string };
    expect(body.error).toContain("no nav map");
  });
});
