import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import type { Finding, SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { registerMcpCancelDeleteTools } from "../mcpCancelDeleteTools.js";
import { registerMcpNavMapTools } from "../mcpNavMapTools.js";
import { registerMcpTools, type McpToolDeps } from "../mcpTools.js";
import { startRun } from "../orchestrator.js";
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
        throw new Error("judge should not be called in this test");
      },
    },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content[0];
  return block?.text ? JSON.parse(block.text) : undefined;
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    runId: "run-1",
    screenId: "screen-1",
    type: "CONSOLE_ERROR",
    evidence: {},
    dedupKey: `dedup-${randomUUID()}`,
    status: "NEW",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

describe("MCP cancel_*/delete_* tools (delete-cancel-spec.md phase 2)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let client: Client;
  let deps: McpToolDeps;
  let findingRepo: FindingRepo;
  let sessionRecordingRepo: SessionRecordingRepo;
  let sessionReplayRunRepo: SessionReplayRunRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-cd-repro-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-cd-screenshot-"));

    findingRepo = new FindingRepo(connection.db);
    sessionRecordingRepo = new SessionRecordingRepo(connection.db);
    sessionReplayRunRepo = new SessionReplayRunRepo(connection.db);
    deps = {
      runRepo: new RunRepo(connection.db),
      findingRepo,
      baselineRepo: new BaselineRepo(connection.db),
      appMapRepo: new AppMapRepo(connection.db),
      testRunRepo: new TestRunRepo(connection.db),
      learningRepo: new LearningRepo(connection.db),
      sessionRecordingRepo,
      sessionReplayRunRepo,
      reproSpecDirectory,
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
      judgeClientFactory: throwingJudgeClient,
      allowedDomains: ["mock.local"],
      productionUrlPatterns: [],
      installRoutes: (context) => installMockTarget(context, "baseline", seedFor()),
    };

    const server = new McpServer({ name: "silly-rabbit-test", version: "1.0.0" });
    registerMcpTools(server, deps);
    registerMcpCancelDeleteTools(server, deps);
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

  it("lists all 22 tools (11 mcpTools + 3 nav-map + 8 cancel/delete)", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(22);
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "cancel_run",
      "cancel_explorer_run",
      "cancel_session_replay_run",
      "delete_run",
      "delete_explorer_run",
      "delete_session_replay_run",
      "delete_session_recording",
      "delete_finding",
      "delete_nav_map",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("cancel_run on a real RUNNING run closes the real chromium instance — isError falsy, cancelled:true", async () => {
    const run = await startRun(
      { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
      {
        ...deps,
        installRoutes: async (context) => {
          await context.route("**/*", () => new Promise(() => {}));
        },
      },
    );
    await waitFor(async () => (await deps.runRepo.get(run.id))?.status === "RUNNING");
    await new Promise((resolve) => setTimeout(resolve, 400));

    const result = await client.callTool({ name: "cancel_run", arguments: { runId: run.id } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as never)).toEqual({ cancelled: true });

    await waitFor(async () => (await deps.runRepo.get(run.id))?.status === "CANCELLED");
  }, 20_000);

  it("cancel_run on an already-terminal run returns isError:true with a clear reason, not a thrown error", async () => {
    const run = await startRun({ charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL }, deps);
    await waitFor(async () => (await deps.runRepo.get(run.id))?.status === "COMPLETED");

    const result = await client.callTool({ name: "cancel_run", arguments: { runId: run.id } });
    expect(result.isError).toBe(true);
    const body = textOf(result as never) as { error: string };
    expect(body.error).toContain("COMPLETED");
  }, 20_000);

  it("cancel_run on an unknown id returns isError:true", async () => {
    const result = await client.callTool({ name: "cancel_run", arguments: { runId: randomUUID() } });
    expect(result.isError).toBe(true);
  });

  it(
    "invalid input (missing runId) is rejected by the tool's own inputSchema, isError:true — matches " +
      "the existing 11-tool precedent, not a thrown protocol error",
    async () => {
      const result = await client.callTool({ name: "cancel_run", arguments: {} });
      expect(result.isError).toBe(true);
    },
  );

  it(
    "delete_run without force previews an accurate blast radius and mutates nothing; with force:true " + "actually deletes and cascades",
    async () => {
      const run = await startRun({ charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL }, deps);
      await waitFor(async () => (await deps.runRepo.get(run.id))?.status === "COMPLETED");

      const finding = makeFinding({ runId: run.id });
      await findingRepo.upsert(finding);

      const preview = await client.callTool({ name: "delete_run", arguments: { runId: run.id } });
      expect(preview.isError).toBe(true);
      const previewBody = textOf(preview as never) as { error: string };
      expect(previewBody.error).toContain("1 finding");
      expect(await deps.runRepo.get(run.id)).not.toBeNull();
      expect(await findingRepo.get(finding.id)).not.toBeNull();

      const forced = await client.callTool({ name: "delete_run", arguments: { runId: run.id, force: true } });
      expect(forced.isError).toBeFalsy();
      const forcedBody = textOf(forced as never) as { deleted: boolean; cascaded: { deletedFindings: number } };
      expect(forcedBody).toEqual({ deleted: true, cascaded: { deletedFindings: 1, deletedTestRun: false } });
      expect(await deps.runRepo.get(run.id)).toBeNull();
      expect(await findingRepo.get(finding.id)).toBeNull();
    },
    20_000,
  );

  it("delete_run on an unknown id returns isError:true, no preview computed", async () => {
    const result = await client.callTool({ name: "delete_run", arguments: { runId: randomUUID() } });
    expect(result.isError).toBe(true);
    const body = textOf(result as never) as { error: string };
    expect(body.error).toBe("run not found");
  });

  it("delete_finding without force previews, with force:true deletes for real — distinct from " + "submit_finding_feedback's dismiss", async () => {
    const finding = makeFinding();
    await findingRepo.upsert(finding);

    const preview = await client.callTool({ name: "delete_finding", arguments: { findingId: finding.id } });
    expect(preview.isError).toBe(true);
    expect(await findingRepo.get(finding.id)).not.toBeNull();

    const forced = await client.callTool({ name: "delete_finding", arguments: { findingId: finding.id, force: true } });
    expect(forced.isError).toBeFalsy();
    expect(await findingRepo.get(finding.id)).toBeNull();
  });

  it("delete_session_recording without force previews the nested cascade count; with force:true " + "deletes the full chain", async () => {
    const recording: SessionRecording = {
      sessionId: randomUUID(),
      targetBaseUrl: MOCK_BASE_URL,
      recordedAt: new Date(),
      steps: [],
    };
    await sessionRecordingRepo.create(recording);
    await sessionReplayRunRepo.create({
      id: randomUUID(),
      sessionId: recording.sessionId,
      replayMode: "live",
      status: "COMPLETED",
      startedAt: new Date(),
      summary: { stepsExecuted: 1, stepsDrifted: 0, stepsErrored: 0 },
    });

    const preview = await client.callTool({
      name: "delete_session_recording",
      arguments: { sessionId: recording.sessionId },
    });
    expect(preview.isError).toBe(true);
    const previewBody = textOf(preview as never) as { error: string };
    expect(previewBody.error).toContain("1 session-replay run");

    const forced = await client.callTool({
      name: "delete_session_recording",
      arguments: { sessionId: recording.sessionId, force: true },
    });
    expect(forced.isError).toBeFalsy();
    expect(await sessionRecordingRepo.get(recording.sessionId)).toBeNull();
  });
});
