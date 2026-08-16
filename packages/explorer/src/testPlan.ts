import { DEFAULT_SONNET_MODEL, type AnthropicLike, type AnthropicMessageResponse } from "@silly-rabbit/engine";
import { FeatureHypothesisSchema, type FeatureHypothesis, type Learning, type ResearchInventory } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolInputSchema } from "./anthropicToolSchema.js";
import { renderResearchMarkdown } from "./researchMarkdown.js";

export interface TestPlanOptions {
  clientFactory: () => AnthropicLike;
  model?: string;
  maxHypotheses?: number;
}

const DEFAULT_MAX_HYPOTHESES = 8;
const MAX_TOKENS = 4096;
const TEST_PLAN_TOOL_NAME = "submit_test_plan";

const HypothesisCardSchema = FeatureHypothesisSchema.omit({ id: true, featureId: true });
const TestPlanToolInputSchema = z.object({ hypotheses: z.array(HypothesisCardSchema) });

function checkJsonSchema(): ToolInputSchema {
  return {
    type: "object",
    properties: {
      description: { type: "string" },
      action: { type: "string", enum: ["submit", "filter", "click"] },
      inputValues: { type: "object", additionalProperties: { type: "string" } },
      expectedOutcome: { type: "string" },
      targetElement: {
        type: "string",
        description:
          "The exact accessibleName of the button element (from the research inventory) this check " +
          "should click, when the action targets one. Name it explicitly rather than leaving it to be " +
          "inferred from the description.",
      },
    },
    required: ["description", "action", "expectedOutcome"],
  };
}

function boundaryCheckJsonSchema(): ToolInputSchema {
  const check = checkJsonSchema();
  return {
    ...check,
    properties: {
      ...(check.properties as Record<string, unknown>),
      category: {
        type: "string",
        enum: ["invalid_input", "empty_required", "long_string", "edge_value", "other"],
      },
    },
    required: [...(check.required ?? []), "category"],
  };
}

function buildTool(): { name: string; description: string; input_schema: ToolInputSchema } {
  return {
    name: TEST_PLAN_TOOL_NAME,
    description: "Submit a structured test plan of feature hypothesis cards for the researched section.",
    input_schema: {
      type: "object",
      properties: {
        hypotheses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              assumption: { type: "string" },
              happyPathCheck: checkJsonSchema(),
              boundaryCheck: boundaryCheckJsonSchema(),
            },
            required: ["assumption", "happyPathCheck", "boundaryCheck"],
          },
        },
      },
      required: ["hypotheses"],
    },
  };
}

function renderActiveLearningsSummary(activeLearnings: Learning[]): string {
  if (activeLearnings.length === 0) {
    return "No active learnings for this feature yet.";
  }
  return activeLearnings.map((learning) => `- [${learning.learningType}] ${learning.description}`).join("\n");
}

function buildPrompt(research: ResearchInventory, activeLearnings: Learning[]): string {
  return [
    "Research inventory for this section:",
    renderResearchMarkdown(research),
    "",
    "Active learnings from prior runs on this feature — skip settled ground (intended_behavior), " +
      "prioritize re-checking confirmed_issue and user_injected_check items:",
    renderActiveLearningsSummary(activeLearnings),
    "",
    "Propose feature hypothesis cards: for each, one happy-path check and one boundary/adversarial " +
      "check, submitted via the tool. When a check's action targets a button (submit/filter/click), " +
      "set targetElement to that button's exact accessibleName as listed in the research inventory " +
      "above — name it explicitly, don't leave it to be inferred from the description text.",
    "Avoid targeting export, download, print, or similarly read-only data-extraction actions " +
      '(e.g. "Export", "Download", "Print") — this feature tests create/read/update/delete behavior ' +
      "on the section's own data, and those actions sit outside that surface even when they're a " +
      "prominent button on the page.",
    'Also avoid targeting import or upload actions (e.g. "Import", "Upload") — testing them requires ' +
      "selecting and submitting a real file, which this framework cannot do yet.",
  ].join("\n");
}

export async function buildTestPlan(
  research: ResearchInventory,
  activeLearnings: Learning[],
  options: TestPlanOptions,
): Promise<FeatureHypothesis[]> {
  const model = options.model ?? DEFAULT_SONNET_MODEL;
  const maxHypotheses = options.maxHypotheses ?? DEFAULT_MAX_HYPOTHESES;
  const client = options.clientFactory();

  let response: AnthropicMessageResponse;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      tools: [buildTool()],
      tool_choice: { type: "tool", name: TEST_PLAN_TOOL_NAME },
      messages: [{ role: "user", content: buildPrompt(research, activeLearnings) }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `test-plan: ${model} unavailable — no test plan will be generated for this run (0 checks). Set ` +
        `ANTHROPIC_API_KEY to enable test-plan generation (or check network/rate-limits if a key is already ` +
        `configured). Detail: ${message}`,
    );
    return [];
  }

  const toolUse = response.content.find((block) => block.type === "tool_use" && block.name === TEST_PLAN_TOOL_NAME);
  const parsed = toolUse ? TestPlanToolInputSchema.safeParse(toolUse.input) : undefined;
  if (!parsed?.success) {
    return [];
  }

  return parsed.data.hypotheses.slice(0, maxHypotheses).map((card) =>
    FeatureHypothesisSchema.parse({
      id: randomUUID(),
      featureId: research.featureId,
      ...card,
    }),
  );
}
