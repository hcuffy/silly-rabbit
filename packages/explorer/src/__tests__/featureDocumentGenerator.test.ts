import { type AnthropicLike, type AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { Learning, ResearchInventory } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { generateFeatureDocument } from "../featureDocumentGenerator.js";

function research(): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [{ kind: "input", accessibleName: "Search", role: "textbox" }],
    entityFields: ["Name", "City"],
    ariaSnapshotMasked: "- table",
    capturedAt: new Date(),
  };
}

function learning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    featureId: "locations",
    learningType: "confirmed_issue",
    description: "the date filter accepts an invalid date without error",
    source: "run_verdict",
    firstSeenRunId: "run-1",
    lastConfirmedRunId: "run-1",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function textResponse(text: string, usage = { input_tokens: 100, output_tokens: 50 }): AnthropicMessageResponse {
  return { content: [{ type: "text", text }], usage };
}

function fakeClient(response: AnthropicMessageResponse): AnthropicLike {
  return { messages: { create: () => Promise.resolve(response) } };
}

function capturingClient(): { client: AnthropicLike; getPrompt: () => string; getCallShape: () => Record<string, unknown> } {
  let capturedPrompt = "";
  let capturedShape: Record<string, unknown> = {};
  const client: AnthropicLike = {
    messages: {
      create: (parameters) => {
        capturedPrompt = parameters.messages[0]?.content ?? "";
        capturedShape = parameters;
        return Promise.resolve(textResponse("generated doc"));
      },
    },
  };
  return { client, getPrompt: () => capturedPrompt, getCallShape: () => capturedShape };
}

describe("generateFeatureDocument (feature-docs-spec §3)", () => {
  it("returns the model's plain-text response as content, defaulting to claude-sonnet-4-6", async () => {
    const result = await generateFeatureDocument(research(), [], { clientFactory: () => fakeClient(textResponse("# doc body")) });
    expect(result.content).toBe("# doc body");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("does not pass tools/tool_choice — plain free-form call, not tool-use", async () => {
    const { client, getCallShape } = capturingClient();
    await generateFeatureDocument(research(), [], { clientFactory: () => client });
    const shape = getCallShape();
    expect(shape.tools).toBeUndefined();
    expect(shape.tool_choice).toBeUndefined();
  });

  it("prompt includes section heading/URL, elements, entity fields, and groups active learnings by type", async () => {
    const { client, getPrompt } = capturingClient();
    const activeLearnings = [
      learning({ learningType: "confirmed_issue", description: "issue A" }),
      learning({ learningType: "intended_behavior", description: "behavior B" }),
    ];
    await generateFeatureDocument(research(), activeLearnings, { clientFactory: () => client });

    const prompt = getPrompt();
    expect(prompt).toContain("Locations");
    expect(prompt).toContain("https://dev.rabbit.example/fleet/locations");
    expect(prompt).toContain("Search");
    expect(prompt).toContain("Name");
    expect(prompt).toContain("confirmed_issue:");
    expect(prompt).toContain("issue A");
    expect(prompt).toContain("intended_behavior:");
    expect(prompt).toContain("behavior B");
  });

  it("does not include ariaSnapshotMasked verbatim in the prompt (decided scope: excluded)", async () => {
    const { client, getPrompt } = capturingClient();
    await generateFeatureDocument({ ...research(), ariaSnapshotMasked: "- UNIQUE_ARIA_MARKER" }, [], {
      clientFactory: () => client,
    });
    expect(getPrompt()).not.toContain("UNIQUE_ARIA_MARKER");
  });

  it("reports 'no active learnings' when the feature has none", async () => {
    const { client, getPrompt } = capturingClient();
    await generateFeatureDocument(research(), [], { clientFactory: () => client });
    expect(getPrompt()).toContain("No active learnings for this feature yet.");
  });

  it("respects an explicit model override", async () => {
    const result = await generateFeatureDocument(research(), [], {
      clientFactory: () => fakeClient(textResponse("doc")),
      model: "claude-opus-4-8",
    });
    expect(result.model).toBe("claude-opus-4-8");
  });

  it("returns empty content, not a throw, if the response has no text block", async () => {
    const result = await generateFeatureDocument(research(), [], {
      clientFactory: () => fakeClient({ content: [], usage: { input_tokens: 10, output_tokens: 0 } }),
    });
    expect(result.content).toBe("");
  });
});
