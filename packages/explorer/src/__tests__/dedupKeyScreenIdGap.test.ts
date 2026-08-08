import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCheckDedupKey } from "../dedupSignature.js";
import { executeHappyPathCheck } from "../happyPathExecutor.js";
import { researchSection } from "../research.js";

function outcomeResponse(input: unknown): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", name: "submit_check_outcome", input }], usage: { input_tokens: 100, output_tokens: 50 } };
}

function fakeJudgeClient(response: AnthropicMessageResponse): AnthropicLike {
  return { messages: { create: () => Promise.resolve(response) } };
}

describe("known gap (explorer-spec §10.3/§10.4, deferred): computeCheckDedupKey's screenId comes from " +
  "research.sectionUrl (captured pre-run), but a real Finding's screenId comes from the post-action observed " +
  "URL — for a check whose action navigates, these two dedupKeys never match", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("a failing check whose submit navigates produces a real Finding.dedupKey that computeCheckDedupKey " +
    "(computed purely from the pre-run research) cannot reproduce", async () => {
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

    const research = await researchSection(page, "locations");
    const check = {
      description: "Submit a valid location",
      action: "submit" as const,
      inputValues: { Name: "Test Location" },
      expectedOutcome: "the location appears in the table",
      targetElement: "Save",
    };

    const client = fakeJudgeClient(outcomeResponse({ passed: false, reasoning: "no row appeared", confidence: 0.9 }));
    const result = await executeHappyPathCheck({
      page,
      research,
      hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      check,
      runId: "run-1",
      judge: { clientFactory: () => client },
    });

    const realDedupKey = result.finding?.dedupKey;
    const purelyComputedDedupKey = computeCheckDedupKey(research, check.description);

    expect(realDedupKey).toBeDefined();
    expect(realDedupKey).not.toBe(purelyComputedDedupKey);
  });
});
