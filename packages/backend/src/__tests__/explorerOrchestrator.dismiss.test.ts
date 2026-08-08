import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { recordFeedback } from "@silly-rabbit/explorer";
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
        if (parameters.tool_choice?.name === "submit_test_plan") return Promise.resolve(testPlanResponse());
        const promptText = parameters.messages[0]?.content ?? "";
        return Promise.resolve(outcomeJudgeResponse(promptText));
      },
    },
  };
}

describe("runExplorerTestRun — dismissed findings are not resurrected on re-detection (D8 dismiss-gap fix)", () => {
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
    screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-dismiss-"));
    browser = await chromium.launch();
    page = await browser.newPage();
  }, 30_000);

  afterAll(async () => {
    await browser.close();
    await closeMongo(connection);
    await mongod.stop();
  });

  it("a dismissed finding stays DISMISSED when the same dedupKey is re-detected on a later run", async () => {
    const featureId = `locations-${randomUUID()}`;
    const deps = {
      testRunRepo,
      learningRepo,
      findingRepo,
      judgeClientFactory: mockAnthropicClient,
      allowedDomains: ["example.test"],
      productionUrlPatterns: [],
      screenshotDirectory,
      screenshotStorageCapBytes: 1_000_000_000,
    };

    await page.setContent(SECTION_PAGE);
    const firstRun = await runExplorerTestRun(
      { page, featureId, runId: `run-${randomUUID()}`, runStartedAt: new Date() },
      deps,
    );
    expect(firstRun.findingIds).toHaveLength(1);
    const originalFindingId = firstRun.findingIds[0];
    if (!originalFindingId) throw new Error("expected first run to produce a finding");

    const originalFinding = await findingRepo.get(originalFindingId);
    if (!originalFinding) throw new Error("expected first run's finding to be persisted");
    expect(originalFinding.status).toBe("NEW");

    await recordFeedback({ finding: originalFinding, featureId, verdict: "dismiss" }, learningRepo, findingRepo);
    const dismissedFinding = await findingRepo.get(originalFindingId);
    expect(dismissedFinding?.status).toBe("DISMISSED");

    await page.setContent(SECTION_PAGE);
    const secondRun = await runExplorerTestRun(
      { page, featureId, runId: `run-${randomUUID()}`, runStartedAt: new Date() },
      deps,
    );

    expect(secondRun.findingIds).toHaveLength(1);
    expect(secondRun.findingIds[0]).toBe(originalFindingId);

    const findingAfterSecondRun = await findingRepo.get(originalFindingId);
    expect(findingAfterSecondRun?.status).toBe("DISMISSED");

    const allFindingsForDedupKey = await findingRepo.findByDedupKeys([originalFinding.dedupKey]);
    expect(allFindingsForDedupKey).toHaveLength(1);
  });
});
