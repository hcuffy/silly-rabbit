import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Finding } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { PNG } from "pngjs";
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

function solidColorPng(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const offset = pixelIndex * 4;
    png.data[offset] = red;
    png.data[offset + 1] = green;
    png.data[offset + 2] = blue;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
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

describe("MCP get_finding — screenshot image content blocks (roadmap item 24, re-scoped)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let client: Client;
  let findingRepo: FindingRepo;
  let screenshotDirectory: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-shot-repro-"));
    screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mcp-shot-screenshot-"));

    findingRepo = new FindingRepo(connection.db);
    const deps: McpToolDeps = {
      runRepo: new RunRepo(connection.db),
      findingRepo,
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

  it("returns both the text/JSON block and an image block whose bytes match the file on disk exactly", async () => {
    const afterBytes = solidColorPng(4, 4, [10, 20, 30]);
    const beforeBytes = solidColorPng(4, 4, [200, 210, 220]);
    const afterPath = join(screenshotDirectory, `after-${randomUUID()}.png`);
    const beforePath = join(screenshotDirectory, `before-${randomUUID()}.png`);
    await writeFile(afterPath, afterBytes);
    await writeFile(beforePath, beforeBytes);

    const finding = makeFinding({ screenshotPath: afterPath, beforeScreenshotPath: beforePath });
    await findingRepo.upsert(finding);

    const result = await client.callTool({ name: "get_finding", arguments: { findingId: finding.id } });
    expect(result.isError).toBeFalsy();
    const blocks = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

    const textBlock = blocks.find((block) => block.type === "text");
    expect(textBlock?.text ? JSON.parse(textBlock.text) : undefined).toMatchObject({ id: finding.id });

    const imageBlocks = blocks.filter((block) => block.type === "image");
    expect(imageBlocks).toHaveLength(2);
    expect(imageBlocks.every((block) => block.mimeType === "image/png")).toBe(true);
    const decodedData = imageBlocks.map((block) => Buffer.from(block.data ?? "", "base64").toString("base64"));
    expect(decodedData).toContain(afterBytes.toString("base64"));
    expect(decodedData).toContain(beforeBytes.toString("base64"));
  });

  it("falls back to text-only, no error, when the finding has no screenshot path at all", async () => {
    const finding = makeFinding();
    await findingRepo.upsert(finding);

    const result = await client.callTool({ name: "get_finding", arguments: { findingId: finding.id } });
    expect(result.isError).toBeFalsy();
    const blocks = result.content as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
  });

  it("falls back to text-only, no error, when screenshotPath is set but the file no longer exists on " +
    "disk (a real, reachable state — enforceScreenshotStorageCap purges files without clearing the " +
    "Finding's path field)", async () => {
    const finding = makeFinding({ screenshotPath: join(screenshotDirectory, `purged-${randomUUID()}.png`) });
    await findingRepo.upsert(finding);

    const result = await client.callTool({ name: "get_finding", arguments: { findingId: finding.id } });
    expect(result.isError).toBeFalsy();
    const blocks = result.content as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
  });
});
