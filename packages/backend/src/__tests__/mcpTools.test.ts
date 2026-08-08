import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { registerMcpNavMapTools } from "../mcpNavMapTools.js";
import { registerMcpTools, type McpToolDeps } from "../mcpTools.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test");
      },
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content[0];
  return block?.text ? JSON.parse(block.text) : undefined;
}

describe("MCP tools (mcp-server-spec §4.4) — read/list/feedback tools and error paths, no browser " +
  "needed for these, real Mongo (mongodb-memory-server), real MCP client/server round-trip " +
  "over InMemoryTransport (not mocked SDK internals)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let client: Client;
  let findingRepo: FindingRepo;
  let sessionRecordingRepo: SessionRecordingRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-repro-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-screenshot-"));

    findingRepo = new FindingRepo(connection.db);
    sessionRecordingRepo = new SessionRecordingRepo(connection.db);
    const deps: McpToolDeps = {
      runRepo: new RunRepo(connection.db),
      findingRepo,
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      sessionRecordingRepo,
      sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
    };

    const server = new McpServer({ name: "silly-rabbit-test", version: "1.0.0" });
    registerMcpTools(server, deps);
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

  it("lists all 14 tools by name (9 from the spec's locked table, the LIST-ALL audit-fix additions " +
    "list_explorer_runs/list_session_replay_runs, and app-mapping-spec.md §8/§11's crawl_nav_map/get_nav_map/delete_nav_map)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "crawl_nav_map",
        "delete_nav_map",
        "get_charter_run",
        "get_explorer_run",
        "get_finding",
        "get_nav_map",
        "get_session_replay_run",
        "list_explorer_runs",
        "list_session_recordings",
        "list_session_replay_runs",
        "submit_finding_feedback",
        "trigger_charter_run",
        "trigger_explorer_run",
        "trigger_session_replay_run",
      ].sort(),
    );
  });

  it("get_charter_run on an unknown runId returns isError, not a thrown protocol error", async () => {
    const result = await client.callTool({ name: "get_charter_run", arguments: { runId: randomUUID() } });
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toEqual({ error: "run not found" });
  });

  it("get_explorer_run on an unknown runId returns isError", async () => {
    const result = await client.callTool({ name: "get_explorer_run", arguments: { runId: randomUUID() } });
    expect(result.isError).toBe(true);
  });

  it("get_session_replay_run on an unknown runId returns isError", async () => {
    const result = await client.callTool({ name: "get_session_replay_run", arguments: { runId: randomUUID() } });
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toEqual({ error: "session-replay run not found" });
  });

  it("get_finding on an unknown findingId returns isError", async () => {
    const result = await client.callTool({ name: "get_finding", arguments: { findingId: randomUUID() } });
    expect(result.isError).toBe(true);
  });

  it("get_finding returns the finding on a known id", async () => {
    const finding = {
      id: randomUUID(),
      runId: "run-1",
      screenId: "screen-1",
      type: "CONSOLE_ERROR" as const,
      evidence: { consoleMessages: ["boom"] },
      dedupKey: `dedup-${randomUUID()}`,
      status: "NEW" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await findingRepo.upsert(finding);

    const result = await client.callTool({ name: "get_finding", arguments: { findingId: finding.id } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as never)).toMatchObject({ id: finding.id, type: "CONSOLE_ERROR" });
  });

  it("submit_finding_feedback dismiss succeeds even without a featureId", async () => {
    const finding = {
      id: randomUUID(),
      runId: "run-1",
      screenId: "screen-1",
      type: "CONSOLE_ERROR" as const,
      evidence: {},
      dedupKey: `dedup-${randomUUID()}`,
      status: "NEW" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await findingRepo.upsert(finding);

    const result = await client.callTool({
      name: "submit_finding_feedback",
      arguments: { findingId: finding.id, verdict: "dismiss" },
    });
    expect(result.isError).toBeFalsy();
    const updated = await findingRepo.get(finding.id);
    expect(updated?.status).toBe("DISMISSED");
  });

  it("submit_finding_feedback confirmed_issue on a finding with no featureId returns isError, mirroring " +
    "the HTTP route's exact same 400 case", async () => {
    const finding = {
      id: randomUUID(),
      runId: "run-1",
      screenId: "screen-1",
      type: "CONSOLE_ERROR" as const,
      evidence: {},
      dedupKey: `dedup-${randomUUID()}`,
      status: "NEW" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await findingRepo.upsert(finding);

    const result = await client.callTool({
      name: "submit_finding_feedback",
      arguments: { findingId: finding.id, verdict: "confirmed_issue" },
    });
    expect(result.isError).toBe(true);
    const body = textOf(result as never) as { error: string };
    expect(body.error).toContain("featureId");
  });

  it("submit_finding_feedback on an unknown findingId returns isError", async () => {
    const result = await client.callTool({
      name: "submit_finding_feedback",
      arguments: { findingId: randomUUID(), verdict: "dismiss" },
    });
    expect(result.isError).toBe(true);
  });

  it("list_session_recordings returns every recording", async () => {
    const recording = {
      sessionId: randomUUID(),
      targetBaseUrl: "https://dev.example",
      recordedAt: new Date(),
      steps: [],
    };
    await sessionRecordingRepo.create(recording);

    const result = await client.callTool({ name: "list_session_recordings", arguments: {} });
    const body = textOf(result as never) as Array<{ sessionId: string }>;
    expect(body.some((entry) => entry.sessionId === recording.sessionId)).toBe(true);
  });

  it("trigger_session_replay_run on an unknown sessionId returns isError, not a thrown protocol error " +
    "(business-logic 'not found', distinct from a schema-validation failure)", async () => {
    const result = await client.callTool({
      name: "trigger_session_replay_run",
      arguments: { sessionId: randomUUID() },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toEqual({ error: "session recording not found" });
  });

  it("invalid input (non-uuid sessionId) is rejected by the tool's own inputSchema before the handler " +
    "ever runs — confirmed empirically (not assumed): the SDK returns this as isError:true content, " +
    "not a thrown/rejected protocol-level error", async () => {
    const result = await client.callTool({
      name: "trigger_session_replay_run",
      arguments: { sessionId: "not-a-uuid" },
    });
    expect(result.isError).toBe(true);
    const block = (result.content as Array<{ text?: string }>)[0];
    expect(block?.text).toContain("Invalid UUID");
  });
});
