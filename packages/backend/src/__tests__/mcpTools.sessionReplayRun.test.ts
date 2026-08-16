import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import type { SessionRecording } from "@silly-rabbit/shared";
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

const MOCK_BASE_URL = "https://replay.local/";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test — no divergence expected");
      },
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content[0];
  return block?.text ? JSON.parse(block.text) : undefined;
}

async function waitForStatus(client: Client, runId: string, terminalStatuses: string[]): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await client.callTool({ name: "get_session_replay_run", arguments: { runId } });
    const body = textOf(result as never) as { status: string };
    if (terminalStatuses.includes(body.status)) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

describe(
  "MCP tools — trigger_session_replay_run / get_session_replay_run (mcp-server-spec §4.4), real " +
    "chromium + real Mongo, direct in-process call (no HTTP hop, per §4.1)",
  () => {
    let mongod: MongoMemoryServer;
    let connection: MongoConnection;
    let client: Client;
    let sessionRecordingRepo: SessionRecordingRepo;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await connectMongo(mongod.getUri());
      const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-replay-repro-"));
      const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-replay-screenshot-"));

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
        reproSpecDirectory,
        screenshotDirectory,
        screenshotStorageCapBytes: 1_000_000_000,
        judgeClientFactory: throwingJudgeClient,
        allowedDomains: ["replay.local"],
        productionUrlPatterns: [],
        installRoutes: async (context) => {
          await context.route(`${MOCK_BASE_URL}**`, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<html><body><h1>Locations</h1><button aria-label="Save">Save</button></body></html>`,
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

    it("triggers a real replay against the mock target and reaches COMPLETED via the poll tool", async () => {
      const sessionRecording: SessionRecording = {
        sessionId: randomUUID(),
        targetBaseUrl: MOCK_BASE_URL,
        recordedAt: new Date(),
        steps: [
          { action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 },
          { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 500 },
        ],
      };
      await sessionRecordingRepo.create(sessionRecording);

      const triggerResult = await client.callTool({
        name: "trigger_session_replay_run",
        arguments: { sessionId: sessionRecording.sessionId, replayMode: "live" },
      });
      expect(triggerResult.isError).toBeFalsy();
      const { runId } = textOf(triggerResult as never) as { runId: string };

      const final = await waitForStatus(client, runId, ["COMPLETED", "FAILED"]);
      expect(final.status).toBe("COMPLETED");
      expect(final.replayMode).toBe("live");
      expect((final.summary as { stepsExecuted: number }).stepsExecuted).toBe(2);
      expect(final.steps).toHaveLength(2);
    }, 15_000);
  },
);
