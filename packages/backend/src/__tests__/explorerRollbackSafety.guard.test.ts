import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { executeBoundaryCheck, rollback } from "@silly-rabbit/explorer";
import type { BoundaryCheck, ResearchInventory } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertAllowedUrl,
  assertNotDestructive,
  assertNotProductionUrl,
  assertRollbackDeleteAllowed,
  SafetyViolation,
} from "../safety.js";

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
const ALLOWED_DOMAINS = ["example.test"];
const PRODUCTION_URL_PATTERNS: RegExp[] = [];

describe("safety-guard boundary — the D8 rollback exception is scoped, everything else is not " +
  "(explorer-spec §9/§13.9, real safety.ts + real chromium)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("assertRollbackDeleteAllowed: refuses an unverified delete click even with the real guard wired", () => {
    expect(() => assertRollbackDeleteAllowed({ role: "button", accessibleName: "Delete" }, false)).toThrow(SafetyViolation);
  });

  it("assertRollbackDeleteAllowed: permits a verified delete click", () => {
    expect(() => assertRollbackDeleteAllowed({ role: "button", accessibleName: "Delete" }, true)).not.toThrow();
  });

  it("rollback()'s own delete click, wired to the real assertRollbackDeleteAllowed, " +
    "succeeds because the caller already verified the match", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <table>
          <tr><th>Name</th><th>Actions</th></tr>
          <tr>
            <td>silly-rabbit-test-guardcheck Row</td>
            <td><button type="button" onclick="this.closest('tr').remove()">Delete</button></td>
          </tr>
        </table>
      </body></html>
    `);

    const result = await rollback(
      page,
      { kind: "marker", marker: "silly-rabbit-test-guardcheck" },
      { onBeforeRollbackDelete: (action, verifiedMarkerMatch) => assertRollbackDeleteAllowed(action, verifiedMarkerMatch) },
    );

    expect(result).toEqual({ status: "OK" });
  });

  it("THE test that matters: a boundary check's own submit click is still hard-refused by ordinary assertNotDestructive " +
    "when it happens to hit something Delete-shaped — general execution has NO exception, only rollback's own click does", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <input aria-label="Name" />
        <button type="button">Delete</button>
      </body></html>
    `);
    const deleteShapedResearch = research({
      elements: [
        { kind: "input", accessibleName: "Name", role: "textbox" },
        { kind: "button", accessibleName: "Delete", role: "button" },
      ],
    });
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "unreached", confidence: 0.9 }));

    await expect(
      executeBoundaryCheck({
        page,
        research: deleteShapedResearch,
        hypothesisId: HYPOTHESIS_ID,
        check: check({ targetElement: "Delete" }),
        runId: RUN_ID,
        runStartedAt: RUN_STARTED_AT,
        judge: { clientFactory: () => client },
        onBeforeAction: (action) => assertNotDestructive(action),
      }),
    ).rejects.toThrow(SafetyViolation);
  });

  it("domain allowlist + prod-URL refusal still fire for a boundary check's own form-submit navigation — never exempted", async () => {
    await page.route("https://example.test/**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/section") {
        await route.fulfill({
          contentType: "text/html",
          body: `<html><body><h1>Locations</h1>
            <form action="https://not-allowed.example/submit" method="post">
              <input aria-label="Name" name="name" />
              <button type="submit">Save</button>
            </form></body></html>`,
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });
    await page.goto("https://example.test/section");
    const client = fakeJudgeClient(outcomeResponse({ passed: true, reasoning: "unreached", confidence: 0.9 }));

    await expect(
      executeBoundaryCheck({
        page,
        research: research(),
        hypothesisId: HYPOTHESIS_ID,
        check: check(),
        runId: RUN_ID,
        runStartedAt: RUN_STARTED_AT,
        judge: { clientFactory: () => client },
        onBeforeNavigate: (url) => {
          assertAllowedUrl(url, ALLOWED_DOMAINS);
          assertNotProductionUrl(url, PRODUCTION_URL_PATTERNS);
        },
      }),
    ).rejects.toThrow(SafetyViolation);
  });

  it("rollback performs no navigation of its own, so the allowlist/prod-URL guards have nothing to skip in the rollback path", async () => {
    await page.setContent(`
      <html><body>
        <h1>Locations</h1>
        <table>
          <tr><th>Name</th><th>Actions</th></tr>
          <tr>
            <td>silly-rabbit-test-nonav Row</td>
            <td><button type="button" onclick="this.closest('tr').remove()">Delete</button></td>
          </tr>
        </table>
      </body></html>
    `);
    const navigationAttempts: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigationAttempts.push(frame.url());
    });

    const result = await rollback(
      page,
      { kind: "marker", marker: "silly-rabbit-test-nonav" },
      { onBeforeRollbackDelete: (action, verifiedMarkerMatch) => assertRollbackDeleteAllowed(action, verifiedMarkerMatch) },
    );

    expect(result).toEqual({ status: "OK" });
    expect(navigationAttempts).toEqual([]);
  });
});
