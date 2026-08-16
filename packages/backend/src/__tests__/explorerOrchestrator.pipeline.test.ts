import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
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
    <input aria-label="Name" />
    <button type="button" id="save">Save</button>
    <table>
      <tr><th>Name</th><th>Actions</th></tr>
    </table>
    <script>
      document.getElementById('save').addEventListener('click', () => {
        const name = document.querySelector('input[aria-label="Name"]').value;
        const table = document.querySelector('table');
        const row = document.createElement('tr');
        row.innerHTML = '<td>' + name + '</td><td>' +
          '<button type="button" onclick="this.closest(\\'tr\\').remove()">Delete</button></td>';
        table.appendChild(row);
      });
    </script>
  </body></html>
`;

const HAPPY_DESCRIPTION = "Submit a valid location";
const BOUNDARY_DESCRIPTION = "Submit with an empty name";

function testPlanResponse(): AnthropicMessageResponse {
  return {
    content: [
      {
        type: "tool_use",
        name: "submit_test_plan",
        input: {
          hypotheses: [
            {
              assumption: "the name field is required",
              happyPathCheck: {
                description: HAPPY_DESCRIPTION,
                action: "submit",
                inputValues: { Name: "Test Location" },
                expectedOutcome: "the location appears in the table",
                targetElement: "Save",
              },
              boundaryCheck: {
                description: BOUNDARY_DESCRIPTION,
                action: "submit",
                inputValues: { Name: "" },
                expectedOutcome: "a validation error is shown",
                category: "empty_required",
                targetElement: "Save",
              },
            },
          ],
        },
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function outcomeJudgeResponse(promptText: string): AnthropicMessageResponse {
  const passed = !promptText.includes(BOUNDARY_DESCRIPTION);
  const reasoning = passed ? "matches expected outcome" : "empty name silently accepted, no validation error shown";
  return {
    content: [{ type: "tool_use", name: "submit_check_outcome", input: { passed, reasoning, confidence: 0.9 } }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function mockAnthropicClient(): AnthropicLike {
  return {
    messages: {
      create: (parameters) => {
        if (parameters.tool_choice?.name === "submit_test_plan") {
          return Promise.resolve(testPlanResponse());
        }
        const promptText = parameters.messages[0]?.content ?? "";
        return Promise.resolve(outcomeJudgeResponse(promptText));
      },
    },
  };
}

describe("runExplorerTestRun — full D8 pipeline (explorer-spec §3/§10, real chromium, real Mongo, no real LLM)", () => {
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
    screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-pipeline-"));
    browser = await chromium.launch();
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await browser.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it(
    "research -> test-plan -> happy-path -> boundary(+rollback despite REGRESSION verdict) -> persists TestRun + " + "Findings, end to end",
    async () => {
      await page.setContent(SECTION_PAGE);
      const featureId = `locations-${randomUUID()}`;
      const runId = `run-${randomUUID()}`;
      const runStartedAt = new Date();

      const testRun = await runExplorerTestRun(
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

      expect(testRun.status).toBe("COMPLETED");
      expect(testRun.featureId).toBe(featureId);
      expect(testRun.runId).toBe(runId);
      expect(testRun.testPlan).toHaveLength(1);
      expect(testRun.checkOutcomes).toEqual([
        { hypothesisId: testRun.testPlan[0]?.id, check: "happy", result: "passed" },
        { hypothesisId: testRun.testPlan[0]?.id, check: "boundary", result: "failed" },
      ]);

      expect(testRun.findingIds).toHaveLength(1);
      const persistedTestRun = await testRunRepo.get(testRun.id);
      expect(persistedTestRun).toEqual(testRun);

      const persistedFindings = await findingRepo.listByRun(runId);
      expect(persistedFindings).toHaveLength(1);
      expect(persistedFindings[0]).toMatchObject({
        id: testRun.findingIds[0],
        type: "BEHAVIOR_CHECK_FAILED",
        verdict: "REGRESSION",
        reasoning: "empty name silently accepted, no validation error shown",
      });

      const screenshotPath = persistedFindings[0]?.screenshotPath;
      expect(screenshotPath).toBeDefined();
      if (!screenshotPath) {
        throw new Error("unreachable — asserted above");
      }
      const screenshotBytes = await readFile(screenshotPath);
      expect(screenshotBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      const beforeScreenshotPath = persistedFindings[0]?.beforeScreenshotPath;
      expect(beforeScreenshotPath).toBeDefined();
      if (!beforeScreenshotPath) {
        throw new Error("unreachable — asserted above");
      }
      expect(beforeScreenshotPath).not.toBe(screenshotPath);
      const beforeScreenshotBytes = await readFile(beforeScreenshotPath);
      expect(beforeScreenshotBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      const rowsRemainingAfterRollback = await page.getByRole("row").all();
      expect(rowsRemainingAfterRollback).toHaveLength(2);
      expect(await page.getByText("Test Location").count()).toBe(1);
    },
  );
});
