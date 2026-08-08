import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { judgeOutcome } from "../outcomeJudge.js";

function toolUseResponse(input: unknown): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", name: "submit_check_outcome", input }], usage: { input_tokens: 100, output_tokens: 50 } };
}

function fakeClient(response: AnthropicMessageResponse): AnthropicLike {
  return { messages: { create: () => Promise.resolve(response) } };
}

const BASE_INPUT = {
  description: "Submit a valid location",
  expectedOutcome: "the location appears in the table",
  ariaSnapshotMasked: '- heading "<TEXT>" [level=1]\n- table',
};

describe("judgeOutcome (explorer-spec §8.2) — distinct from runJudge, own tool/prompt", () => {
  it("a confident passed:true verdict is returned as-is", async () => {
    const client = fakeClient(toolUseResponse({ passed: true, reasoning: "row appeared", confidence: 0.9 }));
    const result = await judgeOutcome(BASE_INPUT, { clientFactory: () => client });
    expect(result).toMatchObject({ passed: true, reasoning: "row appeared", confidence: 0.9 });
    expect(result.infraError).toBeUndefined();
  });

  it("a confident passed:false verdict is returned as-is", async () => {
    const client = fakeClient(toolUseResponse({ passed: false, reasoning: "no row appeared", confidence: 0.85 }));
    const result = await judgeOutcome(BASE_INPUT, { clientFactory: () => client });
    expect(result).toMatchObject({ passed: false, reasoning: "no row appeared", confidence: 0.85 });
  });

  it("a malformed tool response degrades to a zero-confidence result, never throws", async () => {
    const client = fakeClient(toolUseResponse({ passed: "not-a-boolean" }));
    const result = await judgeOutcome(BASE_INPUT, { clientFactory: () => client });
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("no parseable verdict");
  });

  it("a refused/empty response degrades to a zero-confidence result, never throws", async () => {
    const client = fakeClient({ content: [], usage: { input_tokens: 50, output_tokens: 0 } });
    const result = await judgeOutcome(BASE_INPUT, { clientFactory: () => client });
    expect(result.confidence).toBe(0);
  });

  describe("infra/auth failures", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("a thrown network error is flagged distinctly, degrades to zero confidence, never throws", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const client: AnthropicLike = {
        messages: {
          create: () => {
            throw new Error("network down");
          },
        },
      };
      const result = await judgeOutcome(BASE_INPUT, { clientFactory: () => client });
      expect(result.confidence).toBe(0);
      expect(result.infraError).toBe("network down");
      expect(result.reasoning).toContain("unavailable");
    });
  });
});
