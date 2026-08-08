import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import { DEFAULT_SONNET_MODEL } from "@silly-rabbit/engine";
import { describe, expect, it } from "vitest";
import { trackClientUsage } from "../usageTracking.js";

function response(inputTokens: number, outputTokens: number): AnthropicMessageResponse {
  return { content: [], usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

function fakeClient(responses: AnthropicMessageResponse[]): AnthropicLike {
  let index = 0;
  return {
    messages: {
      create: () => {
        const next = responses[index] ?? responses[responses.length - 1];
        index += 1;
        return Promise.resolve(next!);
      },
    },
  };
}

describe("trackClientUsage (D8 cost-tracking fix — previously Run.llmCallsUsed/costUsd were always 0)", () => {
  it("starts at zero before any call is made", () => {
    const { totals } = trackClientUsage(() => fakeClient([response(0, 0)]));
    expect(totals).toEqual({ llmCallsUsed: 0, costUsd: 0 });
  });

  it("counts exactly one call and computes a nonzero cost for it", async () => {
    const { clientFactory, totals } = trackClientUsage(() => fakeClient([response(1000, 500)]));
    const client = clientFactory();
    await client.messages.create({
      model: DEFAULT_SONNET_MODEL,
      max_tokens: 1024,
      tools: [],
      tool_choice: { type: "tool", name: "x" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(totals.llmCallsUsed).toBe(1);
    expect(totals.costUsd).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 10);
  });

  it("accumulates across multiple calls, including calls from multiple clientFactory() invocations " +
    "(same underlying totals object, not reset per call)", async () => {
    const { clientFactory, totals } = trackClientUsage(() => fakeClient([response(100, 50)]));

    const clientA = clientFactory();
    await clientA.messages.create({
      model: DEFAULT_SONNET_MODEL,
      max_tokens: 1024,
      tools: [],
      tool_choice: { type: "tool", name: "x" },
      messages: [{ role: "user", content: "one" }],
    });

    const clientB = clientFactory();
    await clientB.messages.create({
      model: DEFAULT_SONNET_MODEL,
      max_tokens: 1024,
      tools: [],
      tool_choice: { type: "tool", name: "x" },
      messages: [{ role: "user", content: "two" }],
    });

    expect(totals.llmCallsUsed).toBe(2);
    expect(totals.costUsd).toBeCloseTo(2 * ((100 * 3 + 50 * 15) / 1_000_000), 10);
  });

  it("an unrecognized model contributes zero cost but still counts as a call (matches computeCostUsd's own fallback)", async () => {
    const { clientFactory, totals } = trackClientUsage(() => fakeClient([response(1000, 1000)]));
    const client = clientFactory();
    await client.messages.create({
      model: "some-unpriced-model",
      max_tokens: 1024,
      tools: [],
      tool_choice: { type: "tool", name: "x" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(totals.llmCallsUsed).toBe(1);
    expect(totals.costUsd).toBe(0);
  });
});
