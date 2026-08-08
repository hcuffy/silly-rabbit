import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { describe, expect, it, vi } from "vitest";
import { matchSectionWithLlm, type SectionCandidate } from "../sectionLocateLlmFallback.js";

const CANDIDATES: SectionCandidate[] = [
  { role: "listitem", label: "Standorte" },
  { role: "listitem", label: "Nutzer" },
  { role: "link", label: "Ausloggen" },
];

function toolResponse(input: unknown, usage = { input_tokens: 100, output_tokens: 20 }): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", name: "submit_section_match", input }], usage };
}

function clientReturning(response: AnthropicMessageResponse): AnthropicLike {
  return { messages: { create: () => Promise.resolve(response) } };
}

describe("matchSectionWithLlm (explorer-spec §12.1 — cross-language section-match fallback)", () => {
  it("picks the candidate label the model returns, and carries the confidence through unfiltered (capture " +
    "only, no gating logic per §12.1's resolved decision)", async () => {
    const result = await matchSectionWithLlm("the user list and detail view", CANDIDATES, {
      clientFactory: () => clientReturning(toolResponse({ matchedLabel: "Nutzer", confidence: 0.42 })),
    });
    expect(result).toEqual({ matchedLabel: "Nutzer", confidence: 0.42 });
  });

  it("a low confidence score is still returned as a real match, not rejected — no threshold gating exists yet", async () => {
    const result = await matchSectionWithLlm("the user list and detail view", CANDIDATES, {
      clientFactory: () => clientReturning(toolResponse({ matchedLabel: "Nutzer", confidence: 0.02 })),
    });
    expect(result.matchedLabel).toBe("Nutzer");
    expect(result.confidence).toBe(0.02);
  });

  it("the no-match sentinel produces no matchedLabel, same not-found path as any other miss", async () => {
    const result = await matchSectionWithLlm("something entirely unrelated", CANDIDATES, {
      clientFactory: () => clientReturning(toolResponse({ matchedLabel: "NO_MATCH", confidence: 0.8 })),
    });
    expect(result.matchedLabel).toBeUndefined();
    expect(result.confidence).toBe(0.8);
  });

  it("a candidate label carrying a Private-Use-Area icon-ligature glyph still validates when the model's " +
    "returned label drops that glyph — real observed behavior against run f18433c3's target, constrained " +
    "tool output can't round-trip the glyph verbatim", async () => {
    const iconLabelCandidates: SectionCandidate[] = [{ role: "listitem", label: "\u{E939} Standorte" }];
    const result = await matchSectionWithLlm("the locations list and detail view", iconLabelCandidates, {
      clientFactory: () => clientReturning(toolResponse({ matchedLabel: " Standorte", confidence: 0.95 })),
    });
    expect(result).toEqual({ matchedLabel: " Standorte", confidence: 0.95 });
  });

  it("a hallucinated label outside the candidate set is treated as no match, never clicked blind", async () => {
    const result = await matchSectionWithLlm("the user list and detail view", CANDIDATES, {
      clientFactory: () => clientReturning(toolResponse({ matchedLabel: "Some Made Up Label", confidence: 0.9 })),
    });
    expect(result.matchedLabel).toBeUndefined();
  });

  it("an empty candidate list short-circuits without making a call", async () => {
    const clientFactory = vi.fn(() => clientReturning(toolResponse({ matchedLabel: "NO_MATCH", confidence: 0 })));
    const result = await matchSectionWithLlm("anything", [], { clientFactory });
    expect(result).toEqual({ confidence: 0 });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("an infra/network failure degrades to confidence 0, no matchedLabel, and never throws", async () => {
    const result = await matchSectionWithLlm("the user list and detail view", CANDIDATES, {
      clientFactory: () => ({
        messages: { create: () => Promise.reject(new Error("network down")) },
      }),
    });
    expect(result).toEqual({ confidence: 0 });
  });

  it("a malformed tool response (fails schema parse) degrades to confidence 0, no matchedLabel", async () => {
    const result = await matchSectionWithLlm("the user list and detail view", CANDIDATES, {
      clientFactory: () => clientReturning(toolResponse({ matchedLabel: "Nutzer" })),
    });
    expect(result).toEqual({ confidence: 0 });
  });
});
