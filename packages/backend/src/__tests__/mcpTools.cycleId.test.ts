import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Cycle, SessionRecording, TargetProfile } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { registerMcpTools, type McpToolDeps } from "../mcpTools.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { CycleRepo } from "../repos/cycleRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TargetProfileRepo } from "../repos/targetProfileRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const MOCK_BASE_URL = "https://mcp-cycle.local/";
const CREDENTIAL_ENCRYPTION_KEY = "c".repeat(64);

function throwingJudgeClient(): AnthropicLike {
  return { messages: { create: () => { throw new Error("judge should not be called in this test"); } } };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content[0];
  return block?.text ? JSON.parse(block.text) : undefined;
}

function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: randomUUID(),
    name: "MCP Cycle",
    kind: "sprint",
    status: "active",
    isDefault: false,
    runCounter: 0,
    sessionReplayRunCounter: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

async function waitUntilTerminal(client: Client, toolName: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await client.callTool({ name: toolName, arguments: { runId } });
    const body = textOf(result as never) as { status: string };
    if (body.status === "COMPLETED" || body.status === "FAILED") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe("MCP tools — cycleId (run-cycles-spec.md phase 3), real chromium + real Mongo", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let client: Client;
  let cycleRepo: CycleRepo;
  let targetProfileRepo: TargetProfileRepo;
  let sessionRecordingRepo: SessionRecordingRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-cycle-repro-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-cycle-screenshot-"));

    cycleRepo = new CycleRepo(connection.db);
    targetProfileRepo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    sessionRecordingRepo = new SessionRecordingRepo(connection.db);

    const deps: McpToolDeps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      sessionRecordingRepo,
      sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      cycleRepo,
      targetProfileRepo,
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mcp-cycle.local"],
      productionUrlPatterns: [],
      installRoutes: async (context) => {
        await context.route(`${MOCK_BASE_URL}**`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<html><body><h1>Landing</h1><ul><li onclick="window.location.href='${MOCK_BASE_URL}section'">Home</li></ul></body></html>`,
          }),
        );
      },
    };

    const server = new McpServer({ name: "silly-rabbit-test", version: "1.0.0" });
    registerMcpTools(server, deps);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  }, 30_000);

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("trigger_charter_run: cycleId resolves and a real cycleRunNumber is stamped on the persisted Run", async () => {
    const cycle = makeCycle({ name: "Charter Cycle" });
    await cycleRepo.create(cycle);

    const result = await client.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL, cycleId: cycle.id },
    });
    expect(result.isError).toBeFalsy();
    const { runId } = textOf(result as never) as { runId: string };

    const run = await connection.db
      .collection<{ _id: string; cycleId?: string; cycleRunNumber?: number }>("runs")
      .findOne({ _id: runId });
    expect(run?.cycleId).toBe(cycle.id);
    expect(run?.cycleRunNumber).toBe(1);

    await waitUntilTerminal(client, "get_charter_run", runId);
  }, 20_000);

  it("trigger_charter_run: omitting cycleId is unaffected — no cycleId/cycleRunNumber written", async () => {
    const result = await client.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
    });
    expect(result.isError).toBeFalsy();
    const { runId } = textOf(result as never) as { runId: string };

    const run = await connection.db
      .collection<{ _id: string; cycleId?: string; cycleRunNumber?: number }>("runs")
      .findOne({ _id: runId });
    expect(run?.cycleId).toBeUndefined();
    expect(run?.cycleRunNumber).toBeUndefined();

    await waitUntilTerminal(client, "get_charter_run", runId);
  }, 20_000);

  it("trigger_charter_run: profileId and cycleId together apply independently in one call", async () => {
    const profile: TargetProfile = {
      id: randomUUID(),
      name: "Combined MCP Profile",
      baseUrl: MOCK_BASE_URL,
      allowedDomains: ["mcp-cycle.local"],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await targetProfileRepo.create(profile);
    const cycle = makeCycle({ name: "Combined MCP Cycle" });
    await cycleRepo.create(cycle);

    const result = await client.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", profileId: profile.id, cycleId: cycle.id },
    });
    expect(result.isError).toBeFalsy();
    const { runId } = textOf(result as never) as { runId: string };

    const run = await connection.db
      .collection<{ _id: string; targetBaseUrl: string; cycleId?: string; cycleRunNumber?: number }>("runs")
      .findOne({ _id: runId });
    expect(run?.targetBaseUrl).toBe(MOCK_BASE_URL);
    expect(run?.cycleId).toBe(cycle.id);
    expect(run?.cycleRunNumber).toBe(1);

    await waitUntilTerminal(client, "get_charter_run", runId);
  }, 20_000);

  it("trigger_explorer_run: cycleId resolves and a real cycleRunNumber is stamped on the persisted Run", async () => {
    const cycle = makeCycle({ name: "Explorer Cycle" });
    await cycleRepo.create(cycle);

    const result = await client.callTool({
      name: "trigger_explorer_run",
      arguments: {
        featureId: "home",
        sectionDescription: "Home",
        targetBaseUrl: MOCK_BASE_URL,
        cycleId: cycle.id,
      },
    });
    expect(result.isError).toBeFalsy();
    const { runId } = textOf(result as never) as { runId: string };

    const run = await connection.db
      .collection<{ _id: string; cycleId?: string; cycleRunNumber?: number }>("runs")
      .findOne({ _id: runId });
    expect(run?.cycleId).toBe(cycle.id);
    expect(run?.cycleRunNumber).toBe(1);

    await waitUntilTerminal(client, "get_explorer_run", runId);
  }, 20_000);

  it("trigger_session_replay_run: cycleId resolves and is stamped on the persisted SessionReplayRun", async () => {
    const cycle = makeCycle({ name: "Replay Cycle" });
    await cycleRepo.create(cycle);
    const sessionRecording: SessionRecording = {
      sessionId: randomUUID(),
      targetBaseUrl: MOCK_BASE_URL,
      recordedAt: new Date(),
      steps: [{ action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 }],
    };
    await sessionRecordingRepo.create(sessionRecording);

    const result = await client.callTool({
      name: "trigger_session_replay_run",
      arguments: { sessionId: sessionRecording.sessionId, replayMode: "live", cycleId: cycle.id },
    });
    expect(result.isError).toBeFalsy();
    const { runId } = textOf(result as never) as { runId: string };

    const run = await connection.db
      .collection<{ _id: string; cycleId?: string; replayRunNumber?: number }>("sessionReplayRuns")
      .findOne({ _id: runId });
    expect(run?.cycleId).toBe(cycle.id);
    expect(run?.replayRunNumber).toBe(1);

    await waitUntilTerminal(client, "get_session_replay_run", runId);
  }, 20_000);
});
