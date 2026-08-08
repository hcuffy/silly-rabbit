import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { BoundaryCheck, ResearchInventory } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeBoundaryCheck } from "../boundaryExecutor.js";

function research(overrides: Partial<ResearchInventory> = {}): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [
      { kind: "input", accessibleName: "Name", role: "textbox" },
      { kind: "button", accessibleName: "Save", role: "button" },
    ],
    entityFields: [],
    ariaSnapshotMasked: "- heading",
    capturedAt: new Date(),
    ...overrides,
  };
}

function check(overrides: Partial<BoundaryCheck> = {}): BoundaryCheck {
  return {
    description: "Submit with a long name",
    action: "submit",
    inputValues: { Name: "Test Location" },
    expectedOutcome: "a validation error is shown",
    targetElement: "Save",
    category: "long_string",
    ...overrides,
  };
}

function outcomeResponse(input: unknown): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", name: "submit_check_outcome", input }], usage: { input_tokens: 100, output_tokens: 50 } };
}

function fakeJudgeClient(response: AnthropicMessageResponse): AnthropicLike {
  return { messages: { create: () => Promise.resolve(response) } };
}

const HYPOTHESIS_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const RUN_ID = "run-1";
const RUN_STARTED_AT = new Date("2026-07-26T00:00:00.000Z");

const CREATE_AND_LIST_PAGE = `
  <html><body>
    <h1>Locations</h1>
    <input aria-label="Name" />
    <button type="button" id="save">Save</button>
    <table>
      <tr><th>Name</th><th>Region</th><th>Actions</th></tr>
      <tr><td>Existing Warehouse</td><td>East</td><td><button type="button">Delete</button></td></tr>
    </table>
    <script>
      document.getElementById('save').addEventListener('click', () => {
        const name = document.querySelector('input[aria-label="Name"]').value;
        const table = document.querySelector('table');
        const row = document.createElement('tr');
        row.innerHTML = '<td>' + name + '</td><td>West</td><td>' +
          '<button type="button" onclick="this.closest(\\'tr\\').remove()">Delete</button></td>';
        table.appendChild(row);
      });
    </script>
  </body></html>
`;

describe("executeBoundaryCheck (explorer-spec §8.3, real chromium)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("marker path: injects a marker into the free-text field, and rollback finds+deletes the created row (§8.5/§8.7)", async () => {
    await page.setContent(CREATE_AND_LIST_PAGE);
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "validation error shown", confidence: 0.9 }));

    const result = await executeBoundaryCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check(),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: () => client },
    });

    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "boundary", result: "passed" });
    expect(result.findings).toHaveLength(0);
    expect(result.rollback).toEqual({ status: "OK" });
    expect(await (page.getByText("Test Location")).count()).toBe(0);
  });

  it("a confident fail produces a REGRESSION Finding, and rollback still runs regardless of verdict (§8.3 step 4)", async () => {
    await page.setContent(CREATE_AND_LIST_PAGE);
    const client = fakeJudgeClient(outcomeResponse({ passed: false, reasoning: "bad input silently accepted", confidence: 0.9 }));

    const result = await executeBoundaryCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check(),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: () => client },
    });

    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "boundary", result: "failed" });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ type: "BEHAVIOR_CHECK_FAILED", verdict: "REGRESSION", severity: "MEDIUM" });
    expect(result.rollback).toEqual({ status: "OK" });
    expect(await (page.getByText("Test Location")).count()).toBe(0);
  });

  it("two checks with the same description but different category dedup separately (§8.4 — maskedSignature includes category)", async () => {
    const client = fakeJudgeClient(outcomeResponse({ passed: false, reasoning: "bad input silently accepted", confidence: 0.9 }));

    await page.setContent(CREATE_AND_LIST_PAGE);
    const longStringResult = await executeBoundaryCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check({ description: "Submit with a bad value", category: "long_string" }),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: () => client },
    });

    await page.setContent(CREATE_AND_LIST_PAGE);
    const emptyRequiredResult = await executeBoundaryCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check({ description: "Submit with a bad value", category: "empty_required" }),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: () => client },
    });

    const longStringDedupKey = longStringResult.findings.find((finding) => finding.type === "BEHAVIOR_CHECK_FAILED")?.dedupKey;
    const emptyRequiredDedupKey = emptyRequiredResult.findings.find((finding) => finding.type === "BEHAVIOR_CHECK_FAILED")?.dedupKey;
    expect(longStringDedupKey).toBeDefined();
    expect(emptyRequiredDedupKey).toBeDefined();
    expect(longStringDedupKey).not.toBe(emptyRequiredDedupKey);
  });

  it("fallback fieldMatch locator is used and finds+deletes the row when no field is free-text-capable per §8.5's " +
    "exclusion rules — here an Email field is 'input' kind but excluded (§8.6/§11.1)", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <input aria-label="Email" />
        <button type="button" id="save">Save</button>
        <table>
          <tr><th>Email</th><th>Actions</th></tr>
          <tr><td>existing@example.com</td><td><button type="button">Delete</button></td></tr>
        </table>
        <script>
          document.getElementById('save').addEventListener('click', () => {
            const email = document.querySelector('input[aria-label="Email"]').value;
            const table = document.querySelector('table');
            const row = document.createElement('tr');
            row.innerHTML = '<td>' + email + '</td><td>' +
              '<button type="button" onclick="this.closest(\\'tr\\').remove()">Delete</button></td>';
            table.appendChild(row);
          });
        </script>
      </body></html>
    `);
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "ok", confidence: 0.9 }));
    const emailOnlyResearch = research({
      elements: [
        { kind: "input", accessibleName: "Email", role: "textbox" },
        { kind: "button", accessibleName: "Save", role: "button" },
      ],
    });

    const result = await executeBoundaryCheck({
      page,
      research: emailOnlyResearch,
      hypothesisId: HYPOTHESIS_ID,
      check: check({ inputValues: { Email: "new@example.com" }, targetElement: "Save" }),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: () => client },
    });

    expect(result.rollback).toEqual({ status: "OK" });
    expect(result.findings).toHaveLength(0);
    expect(await page.getByText("new@example.com", { exact: true }).count()).toBe(0);
  });

  it("a FAILED rollback surfaces as a WARNING-severity Finding alongside the check finding, run still completes (§11.3)", async () => {
    await page.setContent(`
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
            row.innerHTML = '<td>' + name + '</td><td><button type="button">Delete</button></td>';
            table.appendChild(row);
          });
        </script>
      </body></html>
    `);
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "ok", confidence: 0.9 }));

    const result = await executeBoundaryCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check(),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: () => client },
    });

    expect(result.rollback).toMatchObject({ status: "FAILED", reason: "delete did not take effect" });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ type: "OTHER", verdict: "NEEDS_HUMAN", severity: "WARNING" });
    expect(result.findings[0]?.reasoning).toContain("delete did not take effect");
  });

});
