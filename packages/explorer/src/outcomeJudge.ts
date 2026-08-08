import { DEFAULT_SONNET_MODEL, type AnthropicLike } from "@silly-rabbit/engine";
import { z } from "zod";
import type { ToolInputSchema } from "./anthropicToolSchema.js";

export interface OutcomeJudgeInput {
  description: string;
  expectedOutcome: string;
  ariaSnapshotMasked: string;
  consoleErrors?: string[];
}

export interface OutcomeJudgeResult {
  passed: boolean;
  reasoning: string;
  confidence: number;
}

export interface OutcomeJudgeOptions {
  clientFactory: () => AnthropicLike;
  model?: string;
}

const OUTCOME_TOOL_NAME = "submit_check_outcome";
const MAX_TOKENS = 1024;

const OutcomeInputSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildTool(): { name: string; description: string; input_schema: ToolInputSchema } {
  return {
    name: OUTCOME_TOOL_NAME,
    description: "Submit whether the observed evidence matches this check's expected outcome.",
    input_schema: {
      type: "object",
      properties: {
        passed: { type: "boolean", description: "Whether the expected outcome actually happened." },
        reasoning: { type: "string", description: "Short reasoning for the verdict." },
        confidence: { type: "number", description: "Calibrated confidence in [0,1]." },
      },
      required: ["passed", "reasoning", "confidence"],
      additionalProperties: false,
    },
  };
}

function buildPrompt(input: OutcomeJudgeInput): string {
  return [
    `Check performed: ${input.description}`,
    `Expected outcome: ${input.expectedOutcome}`,
    "Observed accessibility-tree state after performing the check (masked):",
    input.ariaSnapshotMasked,
    input.consoleErrors && input.consoleErrors.length > 0
      ? `Console errors observed: ${input.consoleErrors.join("; ")}`
      : "No console errors observed.",
    "Decide whether the expected outcome actually happened, and submit your verdict via the tool.",
  ].join("\n\n");
}

export async function judgeOutcome(
  input: OutcomeJudgeInput,
  options: OutcomeJudgeOptions,
): Promise<OutcomeJudgeResult & { infraError?: string }> {
  const model = options.model ?? DEFAULT_SONNET_MODEL;

  try {
    const response = await options.clientFactory().messages.create({
      model,
      max_tokens: MAX_TOKENS,
      tools: [buildTool()],
      tool_choice: { type: "tool", name: OUTCOME_TOOL_NAME },
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use" && block.name === OUTCOME_TOOL_NAME);
    const parsed = toolUse ? OutcomeInputSchema.safeParse(toolUse.input) : undefined;
    if (parsed?.success) return parsed.data;

    return { passed: false, reasoning: "Outcome judge returned no parseable verdict.", confidence: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `outcome judge: ${model} unavailable — this check will show as NEEDS_HUMAN without a reasoned verdict. ` +
        `Set ANTHROPIC_API_KEY to enable full judging (or check network/rate-limits if a key is already ` +
        `configured). Detail: ${message}`,
    );
    return {
      passed: false,
      reasoning: `Outcome judge unavailable — showing NEEDS_HUMAN without a reasoned verdict. Set ` +
        `ANTHROPIC_API_KEY to enable full judging (detail: ${message}).`,
      confidence: 0,
      infraError: message,
    };
  }
}
