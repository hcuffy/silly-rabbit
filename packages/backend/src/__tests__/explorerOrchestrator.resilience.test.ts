import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { runExplorerTestRun } from "../explorerOrchestrator.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const SECTION_PAGE = `
  <html><body>
    <h1>Locations</h1>
    <button type="button" id="fast">Fast</button>
    <div style="position:relative; display:inline-block;">
      <button type="button" id="slow">Slow</button>
      <div style="position:absolute; inset:0; z-index:10;"></div>
    </div>
  </body></html>
`;

function testPlanResponse(): AnthropicMessageResponse {
  const boundary = (targetElement: string, description: string) => ({
    description,
    action: "click",
    expectedOutcome: "the click is handled",
    category: "other",
    targetElement,
  });
  return {
    content: [
      {
        type: "tool_use",
        name: "submit_test_plan",
        input: {
          hypotheses: [
            {
              assumption: "the Fast button responds",
              happyPathCheck: { description: "Click Fast", action: "click", expectedOutcome: "handled", targetElement: "Fast" },
              boundaryCheck: boundary("Fast", "Click Fast (boundary)"),
            },
            {
              assumption: "the Slow button responds",
              happyPathCheck: { description: "Click Slow", action: "click", expectedOutcome: "handled", targetElement: "Slow" },
              boundaryCheck: boundary("Slow", "Click Slow (boundary)"),
            },
          ],
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function outcomeResponse(): AnthropicMessageResponse {
  return {
    content: [{ type: "tool_use", name: "submit_check_outcome", input: { passed: true, reasoning: "ok", confidence: 0.9 } }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function mockAnthropicClient(): AnthropicLike {
  return {
    messages: {
      create: (parameters) =>
        Promise.resolve(parameters.tool_choice?.name === "submit_test_plan" ? testPlanResponse() : outcomeResponse()),
    },
  };
}

describe("runExplorerTestRun resilience (D8 live-incident fix — bounded per-check execution, incremental persistence)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let browser: Browser;
  let page: Page;
  let testRunRepo: TestRunRepo;
  let learningRepo: LearningRepo;
  let findingRepo: FindingRepo;
  let screenshotDirectory: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    testRunRepo = new TestRunRepo(connection.db);
    learningRepo = new LearningRepo(connection.db);
    findingRepo = new FindingRepo(connection.db);
    screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-resilience-"));
    browser = await chromium.launch();
    page = await browser.newPage();
    page.setDefaultTimeout(500);
  }, 30_000);

  afterAll(async () => {
    await browser.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("a hung check degrades to a 'timed_out' CheckOutcome instead of killing the run, and the TestRun is " +
    "queryable with real evidence WHILE still RUNNING, not only after completion", async () => {
    await page.setContent(SECTION_PAGE);
    const featureId = `locations-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const runStartedAt = new Date();

    const runPromise = runExplorerTestRun(
      { page, featureId, runId, runStartedAt },
      {
        testRunRepo,
        learningRepo,
        findingRepo,
        judgeClientFactory: mockAnthropicClient,
        allowedDomains: ["example.test"],
        productionUrlPatterns: [],
        screenshotDirectory,
        screenshotStorageCapBytes: 1_000_000_000,
      },
    );

    let observedMidRun = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const midRun = await testRunRepo.getByRunId(runId);
      if (midRun && midRun.checkOutcomes.length >= 2 && midRun.checkOutcomes.length < 4) {
        expect(midRun.status).toBe("RUNNING");
        expect(midRun.checkOutcomes.every((outcome) => outcome.result === "passed")).toBe(true);
        observedMidRun = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(observedMidRun).toBe(true);

    const testRun = await runPromise;

    expect(testRun.status).toBe("COMPLETED");
    expect(testRun.checkOutcomes).toHaveLength(4);
    expect(testRun.checkOutcomes.filter((outcome) => outcome.result === "passed")).toHaveLength(2);
    const stalled = testRun.checkOutcomes.filter((outcome) => outcome.result === "timed_out" || outcome.result === "failed");
    expect(stalled).toHaveLength(2);

    const findings = await findingRepo.listByRun(runId);
    const stalledFindings = findings.filter((finding) => finding.verdict === "NEEDS_HUMAN" && finding.severity === "LOW");
    expect(stalledFindings).toHaveLength(2);
    expect(stalledFindings.every((finding) => finding.reasoning?.includes("Timeout"))).toBe(true);
  }, 20_000);
});
