import { DEFAULT_SONNET_MODEL, type AnthropicLike, type AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { Learning, ResearchInventory } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { buildTestPlan } from "../testPlan.js";

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

function hypothesisCard(overrides: Record<string, unknown> = {}) {
  return {
    assumption: "the name field is required",
    happyPathCheck: {
      description: "Submit a valid location",
      action: "submit",
      expectedOutcome: "the location appears in the table",
    },
    boundaryCheck: {
      description: "Submit with an empty name",
      action: "submit",
      expectedOutcome: "a validation error is shown",
      category: "empty_required",
    },
    ...overrides,
  };
}

function toolUseResponse(input: unknown, usage = { input_tokens: 100, output_tokens: 50 }): AnthropicMessageResponse {
  return { content: [{ type: "tool_use", name: "submit_test_plan", input }], usage };
}

function fakeClient(response: AnthropicMessageResponse): AnthropicLike {
  return { messages: { create: () => Promise.resolve(response) } };
}

describe("buildTestPlan (explorer-spec §7)", () => {
  it("a valid tool response parses into FeatureHypothesis cards with server-assigned id/featureId", async () => {
    const client = fakeClient(toolUseResponse({ hypotheses: [hypothesisCard(), hypothesisCard({ assumption: "second" })] }));
    const plan = await buildTestPlan(research(), [], { clientFactory: () => client });

    expect(plan).toHaveLength(2);
    expect(plan[0]?.featureId).toBe("locations");
    expect(plan[0]?.id).toEqual(expect.any(String));
    expect(plan[0]?.assumption).toBe("the name field is required");
    expect(plan[1]?.assumption).toBe("second");
  });

  it("a malformed tool response (missing required field) degrades to an empty plan, never throws (§7 step 3/§11.4)", async () => {
    const client = fakeClient(toolUseResponse({ hypotheses: [hypothesisCard({ happyPathCheck: { action: "submit" } })] }));
    const plan = await buildTestPlan(research(), [], { clientFactory: () => client });
    expect(plan).toEqual([]);
  });

  it("a refused/empty response degrades to an empty plan, never throws", async () => {
    const client = fakeClient({ content: [], usage: { input_tokens: 50, output_tokens: 0 } });
    const plan = await buildTestPlan(research(), [], { clientFactory: () => client });
    expect(plan).toEqual([]);
  });

  it("an infra/network failure degrades to an empty plan, never throws", async () => {
    const client: AnthropicLike = {
      messages: {
        create: () => {
          throw new Error("network down");
        },
      },
    };
    const plan = await buildTestPlan(research(), [], { clientFactory: () => client });
    expect(plan).toEqual([]);
  });

  it("truncates to the default cap of 8 rather than re-prompting (§13.4)", async () => {
    const cards = Array.from({ length: 10 }, (_, index) => hypothesisCard({ assumption: `card ${index}` }));
    const client = fakeClient(toolUseResponse({ hypotheses: cards }));
    const plan = await buildTestPlan(research(), [], { clientFactory: () => client });
    expect(plan).toHaveLength(8);
    expect(plan[0]?.assumption).toBe("card 0");
    expect(plan[7]?.assumption).toBe("card 7");
  });

  it("respects a custom maxHypotheses override", async () => {
    const cards = Array.from({ length: 5 }, (_, index) => hypothesisCard({ assumption: `card ${index}` }));
    const client = fakeClient(toolUseResponse({ hypotheses: cards }));
    const plan = await buildTestPlan(research(), [], { clientFactory: () => client, maxHypotheses: 3 });
    expect(plan).toHaveLength(3);
  });

  it("includes activeLearnings in the constructed prompt, not just in the call happening", async () => {
    let capturedPrompt = "";
    const client: AnthropicLike = {
      messages: {
        create: (parameters) => {
          capturedPrompt = parameters.messages[0]?.content ?? "";
          return Promise.resolve(toolUseResponse({ hypotheses: [] }));
        },
      },
    };

    const learnings = [
      learning({ learningType: "confirmed_issue", description: "the date filter accepts an invalid date" }),
      learning({ learningType: "user_injected_check", description: "always re-check bulk delete", source: "user_direct" }),
    ];
    await buildTestPlan(research(), learnings, { clientFactory: () => client });

    expect(capturedPrompt).toContain("the date filter accepts an invalid date");
    expect(capturedPrompt).toContain("always re-check bulk delete");
    expect(capturedPrompt).toContain("confirmed_issue");
    expect(capturedPrompt).toContain("user_injected_check");
    expect(capturedPrompt).toContain("skip settled ground");
  });

  it("instructs the model to name the exact button accessibleName via targetElement, not leave it to inference", async () => {
    let capturedPrompt = "";
    const client: AnthropicLike = {
      messages: {
        create: (parameters) => {
          capturedPrompt = parameters.messages[0]?.content ?? "";
          return Promise.resolve(toolUseResponse({ hypotheses: [] }));
        },
      },
    };
    await buildTestPlan(research(), [], { clientFactory: () => client });
    expect(capturedPrompt).toContain("targetElement");
    expect(capturedPrompt).toContain("accessibleName");
    expect(capturedPrompt).toContain("don't leave it to be inferred");
  });

  it(
    "instructs the model to avoid export/download/print-shaped actions as check targets " +
      "(D8 live-incident fix — Export sits outside the CRUD surface this feature tests)",
    async () => {
      let capturedPrompt = "";
      const client: AnthropicLike = {
        messages: {
          create: (parameters) => {
            capturedPrompt = parameters.messages[0]?.content ?? "";
            return Promise.resolve(toolUseResponse({ hypotheses: [] }));
          },
        },
      };
      await buildTestPlan(research(), [], { clientFactory: () => client });
      expect(capturedPrompt).toContain("export");
      expect(capturedPrompt).toContain("download");
      expect(capturedPrompt).toContain("print");
      expect(capturedPrompt).toContain("outside that surface");
    },
  );

  it(
    "instructs the model to avoid import/upload actions as check targets (file-upload exclusion, " + "landed same session as the Export fix)",
    async () => {
      let capturedPrompt = "";
      const client: AnthropicLike = {
        messages: {
          create: (parameters) => {
            capturedPrompt = parameters.messages[0]?.content ?? "";
            return Promise.resolve(toolUseResponse({ hypotheses: [] }));
          },
        },
      };
      await buildTestPlan(research(), [], { clientFactory: () => client });
      expect(capturedPrompt).toContain("import");
      expect(capturedPrompt).toContain("upload");
      expect(capturedPrompt).toContain("cannot do yet");
    },
  );

  it("renders a placeholder summary when there are no active learnings", async () => {
    let capturedPrompt = "";
    const client: AnthropicLike = {
      messages: {
        create: (parameters) => {
          capturedPrompt = parameters.messages[0]?.content ?? "";
          return Promise.resolve(toolUseResponse({ hypotheses: [] }));
        },
      },
    };
    await buildTestPlan(research(), [], { clientFactory: () => client });
    expect(capturedPrompt).toContain("No active learnings for this feature yet.");
  });

  it("uses the pinned default Sonnet model, no escalation call (§13.5)", async () => {
    const seenModels: string[] = [];
    const client: AnthropicLike = {
      messages: {
        create: (parameters) => {
          seenModels.push(parameters.model);
          return Promise.resolve(toolUseResponse({ hypotheses: [] }));
        },
      },
    };
    await buildTestPlan(research(), [], { clientFactory: () => client });
    expect(seenModels).toEqual([DEFAULT_SONNET_MODEL]);
  });
});
