import type { AnthropicLike } from "@silly-rabbit/engine";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { locateSection } from "../sectionLocate.js";

type CreateParameters = Parameters<AnthropicLike["messages"]["create"]>[0];

function fakeSectionMatchClient(matchedLabel: string, confidence: number, onCall?: (parameters: CreateParameters) => void) {
  return (): AnthropicLike => ({
    messages: {
      create: (parameters: CreateParameters) => {
        onCall?.(parameters);
        return Promise.resolve({
          content: [{ type: "tool_use", name: "submit_section_match", input: { matchedLabel, confidence } }],
          usage: { input_tokens: 50, output_tokens: 10 },
        });
      },
    },
  });
}

describe("locateSection — LLM fallback wiring (explorer-spec §12.1), real chromium, fake Anthropic client", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("only calls the LLM after the word-level match fails, never when it already succeeded", async () => {
    page = await browser.newPage();
    await page.setContent("<html><body><ul><li>Standorte</li></ul></body></html>");
    const clientFactory = vi.fn(fakeSectionMatchClient("Standorte", 0.9));

    const result = await locateSection(page, "standorte", { llmClientFactory: clientFactory });

    expect(result?.matchedLabel).toBe("Standorte");
    expect(result?.matchSource).toBe("word");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it(
    "structurally-nav-only candidate filtering excludes a bare button from the LLM candidate list, " + "keeping only link/listitem candidates",
    async () => {
      page = await browser.newPage();
      await page.setContent("<html><body><ul><li>Nutzer</li></ul><button>Chat</button></body></html>");

      let seenEnum: string[] = [];
      const clientFactory = fakeSectionMatchClient("Nutzer", 0.81, (parameters) => {
        const tool = parameters.tools?.[0];
        const matchedLabelProperty = (tool?.input_schema.properties as { matchedLabel?: { enum?: string[] } })?.matchedLabel;
        seenEnum = matchedLabelProperty?.enum ?? [];
      });

      const result = await locateSection(page, "the users list and detail view", { llmClientFactory: clientFactory });

      expect(seenEnum).toContain("Nutzer");
      expect(seenEnum).not.toContain("Chat");
      expect(result?.matchedLabel).toBe("Nutzer");
      expect(result?.matchSource).toBe("llm");
      expect(result?.llmConfidence).toBe(0.81);
    },
  );

  it(
    "a generic word ('detail') that is a substring of an unrelated compound label ('Unternehmensdetails') " +
      "does NOT false-match at word level (real bug: run 5dc2547a) — escalates to the LLM instead, which " +
      "correctly resolves to the real 'Nutzer' label from the candidate set",
    async () => {
      page = await browser.newPage();
      await page.setContent("<html><body><ul><li>Nutzer</li><li>Unternehmensdetails</li></ul></body></html>");
      const clientFactory = vi.fn(fakeSectionMatchClient("Nutzer", 0.85));

      const result = await locateSection(page, "the user list and detail view", { llmClientFactory: clientFactory });

      expect(clientFactory).toHaveBeenCalled();
      expect(result?.matchedLabel).toBe("Nutzer");
      expect(result?.matchSource).toBe("llm");
    },
  );

  it(
    "a PUA icon-ligature glyph in a real nav label survives when the LLM's returned label drops it — the " +
      "REAL glyph-intact label is returned/clicked, not the LLM's degraded string (real bug: run f18433c3)",
    async () => {
      page = await browser.newPage();
      const iconGlyph = "\u{E939}";
      await page.route("https://allowed.example/**", (route) => route.fulfill({ contentType: "text/html", body: "OK" }));
      await page.setContent(
        `<html><body><ul><li onclick="window.location.href='https://allowed.example/section'">${iconGlyph} Standorte</li></ul></body></html>`,
      );
      const clientFactory = vi.fn(fakeSectionMatchClient(" Standorte", 0.95));

      const result = await locateSection(page, "the locations list and detail view", { llmClientFactory: clientFactory });

      expect(result?.matchedLabel).toBe(`${iconGlyph} Standorte`);
      expect(result?.matchSource).toBe("llm");
      expect(result?.sectionUrl).toBe("https://allowed.example/section");
    },
  );

  it("a no-match sentinel from the LLM returns undefined — same not-found path as any other miss (§11.2)", async () => {
    page = await browser.newPage();
    await page.setContent("<html><body><ul><li>Nutzer</li></ul></body></html>");
    const clientFactory = fakeSectionMatchClient("NO_MATCH", 0.9);

    const result = await locateSection(page, "something entirely unrelated", { llmClientFactory: clientFactory });

    expect(result).toBeUndefined();
  });

  it("without an llmClientFactory, a word-level miss still returns undefined — no behavior change for " + "callers that don't opt in", async () => {
    page = await browser.newPage();
    await page.setContent("<html><body><ul><li>Nutzer</li></ul></body></html>");

    const result = await locateSection(page, "something entirely unrelated");

    expect(result).toBeUndefined();
  });

  it(
    "a description whose only significant word is itself a stopword ('section') still word-matches a " +
      "label whose only content word is that same term — stopword filtering must not zero out the token " +
      "set entirely and force a false LLM fallback (regression: explorerApp.costTracking.test.ts, " +
      '"Go To Section")',
    async () => {
      page = await browser.newPage();
      await page.route("https://allowed.example/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<html><body>Section Landed</body></html>" }),
      );
      await page.setContent('<html><body><a href="https://allowed.example/section">Go To Section</a></body></html>');
      const clientFactory = vi.fn(fakeSectionMatchClient("Go To Section", 0.9));

      const result = await locateSection(page, "Go To Section", { llmClientFactory: clientFactory });

      expect(result?.matchedLabel).toBe("Go To Section");
      expect(result?.matchSource).toBe("word");
      expect(clientFactory).not.toHaveBeenCalled();
    },
  );
});
