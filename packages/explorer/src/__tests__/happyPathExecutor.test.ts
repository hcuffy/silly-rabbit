import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { Check, ResearchInventory } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("executeHappyPathCheck (explorer-spec §8.1/§8.2/§8.4, real chromium)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <input aria-label="Name" />
        <button type="button">Save</button>
      </body></html>
    `);
  });

  it("a confident pass produces no Finding, checkOutcome result 'passed' (§8.2 contract)", async () => {
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "row appeared", confidence: 0.9 }));
    const result = await executeHappyPathCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check(),
      runId: RUN_ID,
      judge: { clientFactory: () => client },
    });

    expect(result.finding).toBeUndefined();
    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "happy", result: "passed" });
  });

  it("a confident fail produces a REGRESSION Finding, checkOutcome result 'failed' (§8.2 contract)", async () => {
    const client = fakeJudgeClient(outcomeResponse({ passed: false, reasoning: "no row appeared", confidence: 0.9 }));
    const result = await executeHappyPathCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check(),
      runId: RUN_ID,
      judge: { clientFactory: () => client },
    });

    expect(result.finding).toMatchObject({
      type: "BEHAVIOR_CHECK_FAILED",
      verdict: "REGRESSION",
      severity: "MEDIUM",
      reasoning: "no row appeared",
      confidence: 0.9,
      runId: RUN_ID,
    });
    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "happy", result: "failed" });
  });

  it(
    "two checks with different descriptions on the same screen dedup separately, not into one Finding " +
      "(regression test — description used to be routed through maskText, which collapses any plain-English " +
      "text to the literal '<TEXT>', silently merging every failing happy-path check's dedupKey together)",
    async () => {
      const client = fakeJudgeClient(outcomeResponse({ passed: false, reasoning: "no row appeared", confidence: 0.9 }));

      const first = await executeHappyPathCheck({
        page,
        research: research(),
        hypothesisId: HYPOTHESIS_ID,
        check: check({ description: "Submit a valid location" }),
        runId: RUN_ID,
        judge: { clientFactory: () => client },
      });

      const second = await executeHappyPathCheck({
        page,
        research: research(),
        hypothesisId: HYPOTHESIS_ID,
        check: check({ description: "Submit a location with a different name" }),
        runId: RUN_ID,
        judge: { clientFactory: () => client },
      });

      expect(first.finding?.dedupKey).toBeDefined();
      expect(second.finding?.dedupKey).toBeDefined();
      expect(first.finding?.dedupKey).not.toBe(second.finding?.dedupKey);
    },
  );

  it("a low-confidence verdict produces a NEEDS_HUMAN Finding, checkOutcome result 'failed' (§8.2 contract)", async () => {
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "unsure", confidence: 0.2 }));
    const result = await executeHappyPathCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check(),
      runId: RUN_ID,
      judge: { clientFactory: () => client },
    });

    expect(result.finding).toMatchObject({ verdict: "NEEDS_HUMAN", confidence: 0.2 });
    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "happy", result: "failed" });
  });

  it("a check naming an input field not in the inventory is skipped pre-interaction — NEEDS_HUMAN/LOW (§8.1/§11.5)", async () => {
    const result = await executeHappyPathCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check({ inputValues: { NonExistentField: "x" } }),
      runId: RUN_ID,
      judge: { clientFactory: neverCalledJudgeClient },
    });

    expect(result.finding).toMatchObject({ type: "BEHAVIOR_CHECK_FAILED", verdict: "NEEDS_HUMAN", severity: "LOW", confidence: 0 });
    expect(result.finding?.reasoning).toContain("NonExistentField");
    expect(result.checkOutcome).toEqual({ hypothesisId: HYPOTHESIS_ID, check: "happy", result: "skipped" });
  });

  it("fills the matching input with the check's value before submitting", async () => {
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "ok", confidence: 0.9 }));
    await executeHappyPathCheck({
      page,
      research: research(),
      hypothesisId: HYPOTHESIS_ID,
      check: check({ inputValues: { Name: "Distinctive Test Value" } }),
      runId: RUN_ID,
      judge: { clientFactory: () => client },
    });

    expect(await page.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Distinctive Test Value");
  });
});
