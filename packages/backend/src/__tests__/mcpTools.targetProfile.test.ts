import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import { installMockTarget, type MockSeed } from "@silly-rabbit/driver";
import type { TargetProfile } from "@silly-rabbit/shared";
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
import { TargetProfileRepo } from "../repos/targetProfileRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const MOCK_BASE_URL = "http://mock.local";
const CREDENTIAL_ENCRYPTION_KEY = "d".repeat(64);

function seedFor(): MockSeed {
  return { recordId: randomUUID(), timestamp: new Date().toISOString(), count: 1 };
}

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

function makeProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    id: randomUUID(),
    name: "MCP profile",
    baseUrl: MOCK_BASE_URL,
    allowedDomains: ["mock.local"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("MCP tools — profileId (target-profiles-spec.md phase 3), real chromium + real Mongo", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let client: Client;
  let targetProfileRepo: TargetProfileRepo;
  let clientNoProfileRepo: Client;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-profile-repro-"));
    const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-profile-screenshot-"));
    targetProfileRepo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);

    const baseDeps = {
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
      allowedDomains: ["env-only.example"],
      productionUrlPatterns: [],
      installRoutes: (context: Parameters<NonNullable<McpToolDeps["installRoutes"]>>[0]) =>
        installMockTarget(context, "baseline", seedFor()),
    };

    const deps: McpToolDeps = { ...baseDeps, targetProfileRepo };
    const server = new McpServer({ name: "silly-rabbit-test", version: "1.0.0" });
    registerMcpTools(server, deps);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const noProfileDeps: McpToolDeps = { ...baseDeps };
    const noProfileServer = new McpServer({ name: "silly-rabbit-test-no-profile", version: "1.0.0" });
    registerMcpTools(noProfileServer, noProfileDeps);
    const [noProfileServerTransport, noProfileClientTransport] = InMemoryTransport.createLinkedPair();
    await noProfileServer.connect(noProfileServerTransport);
    clientNoProfileRepo = new Client({ name: "test-client-no-profile", version: "1.0.0" });
    await clientNoProfileRepo.connect(noProfileClientTransport);
  }, 30_000);

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("profileId resolves and its baseUrl applies when targetBaseUrl is omitted", async () => {
    const profile = makeProfile({ id: randomUUID(), name: "Resolves-baseUrl" });
    await targetProfileRepo.create(profile);

    const result = await client.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", profileId: profile.id },
    });

    expect(result.isError).toBeFalsy();
    const { runId } = textOf(result as never) as { runId: string };
    const run = await connection.db.collection<{ _id: string; targetBaseUrl: string }>("runs").findOne({ _id: runId });
    expect(run?.targetBaseUrl).toBe(MOCK_BASE_URL);
  });

  it("an explicit targetBaseUrl still wins over the profile's baseUrl when both are given", async () => {
    const profile = makeProfile({ id: randomUUID(), name: "Explicit-wins", baseUrl: "https://profile-only.example.com" });
    await targetProfileRepo.create(profile);

    const result = await client.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL, profileId: profile.id },
    });

    expect(result.isError).toBeFalsy();
    const { runId } = textOf(result as never) as { runId: string };
    const run = await connection.db.collection<{ _id: string; targetBaseUrl: string }>("runs").findOne({ _id: runId });
    expect(run?.targetBaseUrl).toBe(MOCK_BASE_URL);
  });

  it("an unresolvable profileId returns a clear error, not a crash", async () => {
    const result = await client.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", profileId: randomUUID() },
    });

    expect(result.isError).toBe(true);
    const body = textOf(result as never) as { error: string };
    expect(body.error).toContain("target profile not found");
  });

  it("no targetBaseUrl and no profileId returns a clear error naming both options", async () => {
    const result = await client.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow" },
    });

    expect(result.isError).toBe(true);
    const body = textOf(result as never) as { error: string };
    expect(body.error).toContain("targetBaseUrl");
    expect(body.error).toContain("profileId");
  });

  it("passing profileId when target profiles aren't configured on this MCP server fails gracefully " +
    "(clear errorResult, not an uncaught throw) — same shape a future ephemeral mode would hit", async () => {
    const result = await clientNoProfileRepo.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", profileId: randomUUID() },
    });

    expect(result.isError).toBe(true);
    const body = textOf(result as never) as { error: string };
    expect(body.error).toContain("not configured");
  });

  it("omitting profileId entirely behaves exactly as before — unaffected by any of this", async () => {
    const result = await clientNoProfileRepo.callTool({
      name: "trigger_charter_run",
      arguments: { charter: "test the locations flow", targetBaseUrl: MOCK_BASE_URL },
    });

    expect(result.isError).toBeFalsy();
  });
});
