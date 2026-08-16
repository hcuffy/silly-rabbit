import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { Check, ResearchInventory } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeHappyPathCheck } from "../happyPathExecutor.js";

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

function check(overrides: Partial<Check> = {}): Check {
  return {
    description: "Submit a valid location",
    action: "submit",
    inputValues: { Name: "Test Location" },
    expectedOutcome: "the location appears in the table",
    targetElement: "Save",
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

describe("executeHappyPathCheck — button-targeting precedence (targetElement > description substring > refuse to guess)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("prefers targetElement over a coincidental description substring match pointing at a different button", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <button type="button" onclick="document.title = 'export-clicked'">Export</button>
        <button type="button" onclick="document.title = 'save-clicked'">Save</button>
      </body></html>
    `);
    const twoButtonResearch = research({
      elements: [
        { kind: "button", accessibleName: "Export", role: "button" },
        { kind: "button", accessibleName: "Save", role: "button" },
      ],
    });
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "ok", confidence: 0.9 }));

    await executeHappyPathCheck({
      page,
      research: twoButtonResearch,
      hypothesisId: HYPOTHESIS_ID,
      check: check({ description: "Export the location list", inputValues: {}, targetElement: "Save" }),
      runId: RUN_ID,
      judge: { clientFactory: () => client },
    });

    expect(await page.title()).toBe("save-clicked");
  });

  it("falls back to a description substring match when targetElement is absent", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <button type="button" onclick="document.title = 'archive-clicked'">Archive</button>
        <button type="button" onclick="document.title = 'save-clicked'">Save</button>
      </body></html>
    `);
    const twoButtonResearch = research({
      elements: [
        { kind: "button", accessibleName: "Archive", role: "button" },
        { kind: "button", accessibleName: "Save", role: "button" },
      ],
    });
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "ok", confidence: 0.9 }));

    await executeHappyPathCheck({
      page,
      research: twoButtonResearch,
      hypothesisId: HYPOTHESIS_ID,
      check: check({ description: "Click the Archive button", inputValues: {}, targetElement: undefined }),
      runId: RUN_ID,
      judge: { clientFactory: () => client },
    });

    expect(await page.title()).toBe("archive-clicked");
  });

  it("a targetElement matching no button is refused, not guessed — NEEDS_HUMAN/skip, judge never called", async () => {
    await page.setContent(`<html><body><h1>Locations</h1><button type="button">Save</button></body></html>`);
    const result = await executeHappyPathCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check({ inputValues: {}, targetElement: "Does Not Exist" }),
      runId: RUN_ID,
      judge: { clientFactory: neverCalledJudgeClient },
    });

    expect(result.finding).toMatchObject({ verdict: "NEEDS_HUMAN", severity: "LOW", confidence: 0 });
    expect(result.finding?.reasoning).toContain("Does Not Exist");
    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "happy", result: "skipped" });
  });

  it("no targetElement and no description substring match, buttons present, is refused — NEEDS_HUMAN/skip, judge never called", async () => {
    await page.setContent(`<html><body><h1>Locations</h1><button type="button">Save</button></body></html>`);
    const result = await executeHappyPathCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check({ description: "Do something unrelated", inputValues: {}, targetElement: undefined }),
      runId: RUN_ID,
      judge: { clientFactory: neverCalledJudgeClient },
    });

    expect(result.finding).toMatchObject({ verdict: "NEEDS_HUMAN", severity: "LOW", confidence: 0 });
    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "happy", result: "skipped" });
  });

  it(
    "a targetElement naming an export/download/print-shaped button is refused at execution — deterministic guard, " +
      "not just a prompt instruction — judge never called, click never fires even though the button genuinely " +
      "exists and matches (D8 live-incident fix, same reasoning as marker.ts's auth/routing exclusion)",
    async () => {
      await page.setContent(
        `<html><body><h1>Locations</h1><button type="button" onclick="document.title = 'export-clicked'">Export</button></body></html>`,
      );
      const exportResearch = research({ elements: [{ kind: "button", accessibleName: "Export", role: "button" }] });

      const result = await executeHappyPathCheck({
        page,
        research: exportResearch,
        hypothesisId: HYPOTHESIS_ID,
        check: check({ inputValues: {}, targetElement: "Export" }),
        runId: RUN_ID,
        judge: { clientFactory: neverCalledJudgeClient },
      });

      expect(result.finding).toMatchObject({ verdict: "NEEDS_HUMAN", severity: "LOW", confidence: 0 });
      expect(result.finding?.reasoning).toContain("Export");
      expect(result.finding?.reasoning).toContain("outside the CRUD surface");
      expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "happy", result: "skipped" });
      expect(await page.title()).not.toBe("export-clicked");
    },
  );

  it(
    "a targetElement naming an import/upload-shaped button is refused at execution — same deterministic guard, " +
      "separate exclusion reason (file-upload, not read-only-export) since Import is legitimate CRUD surface, just " +
      "untestable without file-picker handling — judge never called, click never fires",
    async () => {
      await page.setContent(
        `<html><body><h1>Locations</h1><button type="button" onclick="document.title = 'import-clicked'">Import</button></body></html>`,
      );
      const importResearch = research({ elements: [{ kind: "button", accessibleName: "Import", role: "button" }] });

      const result = await executeHappyPathCheck({
        page,
        research: importResearch,
        hypothesisId: HYPOTHESIS_ID,
        check: check({ inputValues: {}, targetElement: "Import" }),
        runId: RUN_ID,
        judge: { clientFactory: neverCalledJudgeClient },
      });

      expect(result.finding).toMatchObject({ verdict: "NEEDS_HUMAN", severity: "LOW", confidence: 0 });
      expect(result.finding?.reasoning).toContain("Import");
      expect(result.finding?.reasoning).toContain("file-upload action");
      expect(result.finding?.reasoning).not.toContain("outside the CRUD surface");
      expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "happy", result: "skipped" });
      expect(await page.title()).not.toBe("import-clicked");
    },
  );

  it("zero buttons in the inventory is 'not needed', not an error — proceeds straight to the judge with no click", async () => {
    await page.setContent(`<html><body><h1>Locations</h1><input aria-label="Name" /></body></html>`);
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "ok", confidence: 0.9 }));
    const noButtonResearch = research({ elements: [{ kind: "input", accessibleName: "Name", role: "textbox" }] });

    const result = await executeHappyPathCheck({
      page,
      research: noButtonResearch,
      hypothesisId: HYPOTHESIS_ID,
      check: check({ inputValues: { Name: "x" }, targetElement: undefined }),
      runId: RUN_ID,
      judge: { clientFactory: () => client },
    });

    expect(result.checkOutcome.result).toBe("passed");
  });
});

describe("executeHappyPathCheck — onBeforeNavigate, worst-case proof via a real <form>", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("fires with the resolved form-action URL, and a real navigation occurs for genuine <form>+type=submit markup", async () => {
    await page.route("https://example.test/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/section") {
        await route.fulfill({
          contentType: "text/html",
          body: `<html><body><h1>Locations</h1>
            <form action="/submit" method="post">
              <input aria-label="Name" name="name" />
              <button type="submit">Save</button>
            </form></body></html>`,
        });
        return;
      }
      if (pathname === "/submit") {
        await route.fulfill({ contentType: "text/html", body: `<html><body><h1>Submitted</h1></body></html>` });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });
    await page.goto("https://example.test/section");

    const calledWith: string[] = [];
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "ok", confidence: 0.9 }));

    await executeHappyPathCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check(),
      runId: RUN_ID,
      judge: { clientFactory: () => client },
      onBeforeNavigate: (url) => {
        calledWith.push(url);
      },
    });

    expect(calledWith).toEqual(["https://example.test/submit"]);
    expect(page.url()).toBe("https://example.test/submit");
  });
});
