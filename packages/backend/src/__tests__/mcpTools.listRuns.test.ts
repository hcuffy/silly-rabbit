import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import type { ResearchInventory, SessionReplayRun, TestRun } from "@silly-rabbit/shared";
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

function makeResearch(): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [],
    entityFields: [],
    ariaSnapshotMasked: "- heading",
    capturedAt: new Date(),
  };
}

describe(
  "MCP tools — list_explorer_runs / list_session_replay_runs (LIST-ALL audit fix), same shape " + "convention as list_session_recordings",
  () => {
    let mongod: MongoMemoryServer;
    let connection: MongoConnection;
    let client: Client;
    let testRunRepo: TestRunRepo;
    let sessionReplayRunRepo: SessionReplayRunRepo;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await connectMongo(mongod.getUri());
      const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-list-repro-"));
      const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-list-screenshot-"));

      testRunRepo = new TestRunRepo(connection.db);
      sessionReplayRunRepo = new SessionReplayRunRepo(connection.db);
      const deps: McpToolDeps = {
        runRepo: new RunRepo(connection.db),
        findingRepo: new FindingRepo(connection.db),
        baselineRepo: new BaselineRepo(connection.db),
        appMapRepo: new AppMapRepo(connection.db),
        testRunRepo,
        learningRepo: new LearningRepo(connection.db),
        sessionRecordingRepo: new SessionRecordingRepo(connection.db),
        sessionReplayRunRepo,
        reproSpecDirectory,
        screenshotDirectory,
        screenshotStorageCapBytes: 1_000_000_000,
        judgeClientFactory: throwingJudgeClient,
        allowedDomains: ["mock.local"],
        productionUrlPatterns: [],
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

    it("list_explorer_runs returns paginated TestRuns", async () => {
      const testRun: TestRun = {
        id: randomUUID(),
        featureId: "locations",
        runId: randomUUID(),
        research: makeResearch(),
        testPlan: [],
        checkOutcomes: [],
        findingIds: [],
        startedAt: new Date(),
        status: "COMPLETED",
      };
      await testRunRepo.create(testRun);

      const result = await client.callTool({ name: "list_explorer_runs", arguments: {} });
      expect(result.isError).toBeFalsy();
      const body = textOf(result as never) as { testRuns: TestRun[]; total: number };
      expect(body.testRuns.some((entry) => entry.id === testRun.id)).toBe(true);
    });

    it("list_explorer_runs respects an explicit limit", async () => {
      const result = await client.callTool({ name: "list_explorer_runs", arguments: { limit: 1 } });
      const body = textOf(result as never) as { testRuns: TestRun[] };
      expect(body.testRuns).toHaveLength(1);
    });

    it("list_session_replay_runs returns paginated SessionReplayRuns", async () => {
      const run: SessionReplayRun = {
        id: randomUUID(),
        sessionId: randomUUID(),
        replayMode: "live",
        status: "COMPLETED",
        startedAt: new Date(),
        summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
      };
      await sessionReplayRunRepo.create(run);

      const result = await client.callTool({ name: "list_session_replay_runs", arguments: {} });
      expect(result.isError).toBeFalsy();
      const body = textOf(result as never) as { sessionReplayRuns: SessionReplayRun[]; total: number };
      expect(body.sessionReplayRuns.some((entry) => entry.id === run.id)).toBe(true);
    });
  },
);
