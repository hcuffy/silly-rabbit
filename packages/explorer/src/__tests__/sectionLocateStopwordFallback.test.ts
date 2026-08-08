import type { AnthropicLike } from "@silly-rabbit/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { locateSection } from "../sectionLocate.js";

function fakeSectionMatchClient(matchedLabel: string, confidence: number) {
  return (): AnthropicLike => ({
    messages: {
      create: () =>
        Promise.resolve({
          content: [{ type: "tool_use", name: "submit_section_match", input: { matchedLabel, confidence } }],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
    },
  });
}

describe("locateSection — stopword-fallback tiering (real bug found via live dogfooding: generic-noun " +
  "collision on a compound label)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("a description whose only significant words are all anti-collision generic nouns ('list', 'details', " +
    "'view') no longer word-matches an unrelated compound label containing one of them as a whole token " +
    "(real bug: 'Unternehmens-details' falsely matched 'list and details view') — escalates to the LLM " +
    "instead, which correctly resolves to the real 'Standorte' label", async () => {
    page = await browser.newPage();
    await page.setContent(
      "<html><body><ul><li>Standorte</li><li>Unternehmens-details</li></ul></body></html>",
    );
    const clientFactory = vi.fn(fakeSectionMatchClient("Standorte", 0.88));

    const result = await locateSection(page, "list and details view", { llmClientFactory: clientFactory });

    expect(clientFactory).toHaveBeenCalled();
    expect(result?.matchedLabel).toBe("Standorte");
    expect(result?.matchSource).toBe("llm");
  });

  it("a description made entirely of connector words ('with and for') empties out at both stopword tiers — " +
    "still routes cleanly to the LLM fallback rather than false-matching or throwing on an empty word set",
  async () => {
    page = await browser.newPage();
    await page.setContent("<html><body><ul><li>Nutzer</li></ul></body></html>");
    const clientFactory = vi.fn(fakeSectionMatchClient("Nutzer", 0.7));

    const result = await locateSection(page, "with and for", { llmClientFactory: clientFactory });

    expect(clientFactory).toHaveBeenCalled();
    expect(result?.matchedLabel).toBe("Nutzer");
    expect(result?.matchSource).toBe("llm");
  });
});
