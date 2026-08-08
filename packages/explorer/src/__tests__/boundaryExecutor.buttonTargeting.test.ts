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

function neverCalledJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called — check should have been skipped pre-interaction");
      },
    },
  };
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

describe("executeBoundaryCheck — button-targeting precedence and execution-time guards", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("a check naming a field not in the inventory is skipped pre-interaction, no rollback attempted (§11.5)", async () => {
    await page.setContent(CREATE_AND_LIST_PAGE);
    const result = await executeBoundaryCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check({ inputValues: { NonExistentField: "x" } }),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: () => fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "n/a", confidence: 0.9 })) },
    });

    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "boundary", result: "skipped" });
    expect(result.rollback).toBeUndefined();
  });

  it("a targetElement naming an export/download/print-shaped button is refused at execution — deterministic " +
    "guard, judge never called, click never fires, no marker/rollback attempted even though the button " +
    "genuinely exists and matches (D8 live-incident fix)", async () => {
    await page.setContent(
      `<html><body><h1>Locations</h1><input aria-label="Name" />` +
        `<button type="button" onclick="document.title = 'export-clicked'">Export</button></body></html>`,
    );
    const exportResearch = research({
      elements: [
        { kind: "input", accessibleName: "Name", role: "textbox" },
        { kind: "button", accessibleName: "Export", role: "button" },
      ],
    });

    const result = await executeBoundaryCheck({
      page,
      research: exportResearch,
      hypothesisId: HYPOTHESIS_ID,
      check: check({ targetElement: "Export" }),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: neverCalledJudgeClient },
    });

    expect(result.findings[0]).toMatchObject({ verdict: "NEEDS_HUMAN", severity: "LOW", confidence: 0 });
    expect(result.findings[0]?.reasoning).toContain("Export");
    expect(result.findings[0]?.reasoning).toContain("outside the CRUD surface");
    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "boundary", result: "skipped" });
    expect(result.rollback).toBeUndefined();
    expect(await page.title()).not.toBe("export-clicked");
  });

  it("a targetElement naming an import/upload-shaped button is refused at execution — same deterministic guard, " +
    "separate exclusion reason (file-upload) since Import is legitimate CRUD surface, just untestable without " +
    "file-picker handling — judge never called, click never fires, no marker/rollback attempted", async () => {
    await page.setContent(
      `<html><body><h1>Locations</h1><input aria-label="Name" />` +
        `<button type="button" onclick="document.title = 'import-clicked'">Import</button></body></html>`,
    );
    const importResearch = research({
      elements: [
        { kind: "input", accessibleName: "Name", role: "textbox" },
        { kind: "button", accessibleName: "Import", role: "button" },
      ],
    });

    const result = await executeBoundaryCheck({
      page,
      research: importResearch,
      hypothesisId: HYPOTHESIS_ID,
      check: check({ targetElement: "Import" }),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: neverCalledJudgeClient },
    });

    expect(result.findings[0]).toMatchObject({ verdict: "NEEDS_HUMAN", severity: "LOW", confidence: 0 });
    expect(result.findings[0]?.reasoning).toContain("Import");
    expect(result.findings[0]?.reasoning).toContain("file-upload action");
    expect(result.findings[0]?.reasoning).not.toContain("outside the CRUD surface");
    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "boundary", result: "skipped" });
    expect(result.rollback).toBeUndefined();
    expect(await page.title()).not.toBe("import-clicked");
  });

  it("a non-mutating check (action 'filter') never gets a marker or rollback — nothing was created to roll back", async () => {
    await page.setContent(CREATE_AND_LIST_PAGE);
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "filter applied", confidence: 0.9 }));

    const result = await executeBoundaryCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check({ description: "Filter by an invalid name", action: "filter" }),
      runId: RUN_ID,
      runStartedAt: RUN_STARTED_AT,
      judge: { clientFactory: () => client },
    });

    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "boundary", result: "passed" });
    expect(result.rollback).toBeUndefined();
    expect(result.findings).toHaveLength(0);
    expect(await page.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Test Location");
  });
});
