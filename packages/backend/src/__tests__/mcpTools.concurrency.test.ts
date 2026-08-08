import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
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
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const MOCK_BASE_URL = "http://mock.local";

function seedFor(): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 1 };
}

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called — no divergence expected in this test");
      },
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content[0];
  return block?.text ? JSON.parse(block.text) : undefined;
}

async function waitForStatus(client: Client, runId: string, terminalStatuses: string[]): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await client.callTool({ name: "get_charter_run", arguments: { runId } });
    const body = textOf(result as never) as { status: string };
    if (terminalStatuses.includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe("MCP trigger_charter_run concurrency cap (RESOURCE EXHAUSTION audit fix) — same shared cap " +
  "as the HTTP route, isError:true rather than a thrown protocol error", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let client: Client;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-cap-repro-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-cap-screenshot-"));

    const deps: McpToolDeps = {
      runRepo: new RunRepo(connection.db),
      findingRepo: new FindingRepo(connection.db),
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      sessionRecordingRepo: new SessionRecordingRepo(connection.db),
      sessionReplayRunRepo: new SessionReplayRunRepo(connection.db),
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      maxConcurrentRuns: 1,
      installRoutes: (context) => installMockTarget(context, "baseline", seedFor()),
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

  it("rejects the 2nd of 2 rapid-fire triggers with isError:true while the 1st proceeds, then accepts " +
    "a 3rd once the 1st completes", async () => {
    const [first, second] = await Promise.all([
      client.callTool({ name: "trigger_charter_run", arguments: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL } }),
      client.callTool({ name: "trigger_charter_run", arguments: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL } }),
    ]);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBe(true);
    const body = textOf(second as never) as { error: string };
    expect(body.error).toContain("max concurrent runs");

    const { runId: firstRunId } = textOf(first as never) as { runId: string };
    await waitForStatus(client, firstRunId, ["COMPLETED", "FAILED"]);

    const third = await client.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
    });
    expect(third.isError).toBeFalsy();
  }, 30_000);
});
