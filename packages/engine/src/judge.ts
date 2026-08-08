import type { Finding } from "@silly-rabbit/shared";
import { z } from "zod";

export interface JudgeVerdict {
  verdict: NonNullable<Finding["verdict"]>;
  severity: NonNullable<Finding["severity"]>;
  reasoning: string;
  confidence: number;
}

export interface JudgeUsage {
  llmCallsUsed: number;
  costUsd: number;
}

export interface JudgeInput {
  charter: string;
  screenId: string;
  baselineAriaSnapshotMasked: string;
  currentAriaSnapshotMasked: string;
}

export interface AnthropicMessageResponse {
  content: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

interface ToolInputSchema {
  type: "object";
  properties?: unknown;
  required?: string[];
  [key: string]: unknown;
}

export interface AnthropicLike {
  messages: {
    create(parameters: {
      model: string;
      max_tokens: number;
      tools?: Array<{ name: string; description: string; input_schema: ToolInputSchema }>;
      tool_choice?: { type: "tool"; name: string };
      messages: Array<{ role: "user"; content: string }>;
    }): Promise<AnthropicMessageResponse>;
  };
}

export interface JudgeRunOptions {
  clientFactory: () => AnthropicLike;
  sonnetModel?: string;
  opusModel?: string;
  confidenceThreshold?: number;
}

export const DEFAULT_SONNET_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPUS_MODEL = "claude-opus-4-8";
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const MAX_TOKENS = 1024;
const VERDICT_TOOL_NAME = "submit_verdict";

const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  [DEFAULT_SONNET_MODEL]: { inputPerMTok: 3, outputPerMTok: 15 },
  [DEFAULT_OPUS_MODEL]: { inputPerMTok: 5, outputPerMTok: 25 },
};

export function computeCostUsd(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (usage.input_tokens * pricing.inputPerMTok + usage.output_tokens * pricing.outputPerMTok) / 1_000_000;
}

const VerdictInputSchema = z.object({
  verdict: z.enum(["REGRESSION", "INTENDED_CHANGE", "NEEDS_HUMAN"]),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildTool(): { name: string; description: string; input_schema: ToolInputSchema } {
  return {
    name: VERDICT_TOOL_NAME,
    description:
      "Submit a structured verdict for whether a detected UI state divergence is an intended change or a regression.",
    input_schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["REGRESSION", "INTENDED_CHANGE", "NEEDS_HUMAN"] },
        severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
        reasoning: { type: "string", description: "Short reasoning for the verdict." },
        confidence: { type: "number", description: "Calibrated confidence in [0,1]." },
      },
      required: ["verdict", "severity", "reasoning", "confidence"],
      additionalProperties: false,
    },
  };
}

function buildPrompt(input: JudgeInput): string {
  return [
    `Charter (what this run is testing): ${input.charter}`,
    `Screen: ${input.screenId}`,
    "Baseline accessibility-tree state (masked):",
    input.baselineAriaSnapshotMasked,
    "Current accessibility-tree state (masked):",
    input.currentAriaSnapshotMasked,
    "Decide whether the change from baseline to current is an intended change or a regression, and submit your verdict via the tool.",
  ].join("\n\n");
}

interface CallResult {
  verdict: JudgeVerdict | undefined;
  usage: JudgeUsage;
  infraError?: string;
}

async function callModel(input: JudgeInput, client: AnthropicLike, model: string): Promise<CallResult> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      tools: [buildTool()],
      tool_choice: { type: "tool", name: VERDICT_TOOL_NAME },
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const usage: JudgeUsage = { llmCallsUsed: 1, costUsd: computeCostUsd(model, response.usage) };
    const toolUse = response.content.find((block) => block.type === "tool_use" && block.name === VERDICT_TOOL_NAME);
    const parsed = toolUse ? VerdictInputSchema.safeParse(toolUse.input) : undefined;

    return { verdict: parsed?.success ? parsed.data : undefined, usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `judge: ${model} unavailable — this finding will show as NEEDS_HUMAN without a reasoned verdict. ` +
        `Set ANTHROPIC_API_KEY to enable full judging (or check network/rate-limits if a key is already ` +
        `configured). Detail: ${message}`,
    );
    return { verdict: undefined, usage: { llmCallsUsed: 1, costUsd: 0 }, infraError: message };
  }
}

function describeJudgeFailure(result: CallResult): string {
  return result.infraError
    ? `Judge unavailable — showing NEEDS_HUMAN without a reasoned verdict. Set ANTHROPIC_API_KEY to ` +
      `enable full judging (detail: ${result.infraError}).`
    : "Judge returned no parseable verdict.";
}

export async function runJudge(
  input: JudgeInput,
  options: JudgeRunOptions,
): Promise<JudgeVerdict & JudgeUsage & { infraError?: string; escalatedToOpus: boolean }> {
  const sonnetModel = options.sonnetModel ?? DEFAULT_SONNET_MODEL;
  const opusModel = options.opusModel ?? DEFAULT_OPUS_MODEL;
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const sonnet = await callModel(input, options.clientFactory(), sonnetModel);
  if (!sonnet.verdict) {
    return {
      verdict: "NEEDS_HUMAN",
      severity: "MEDIUM",
      reasoning: describeJudgeFailure(sonnet),
      confidence: 0,
      ...sonnet.usage,
      infraError: sonnet.infraError,
      escalatedToOpus: false,
    };
  }
  if (sonnet.verdict.confidence >= threshold) {
    return { ...sonnet.verdict, ...sonnet.usage, escalatedToOpus: false };
  }

  const opus = await callModel(input, options.clientFactory(), opusModel);
  const combinedUsage: JudgeUsage = {
    llmCallsUsed: sonnet.usage.llmCallsUsed + opus.usage.llmCallsUsed,
    costUsd: sonnet.usage.costUsd + opus.usage.costUsd,
  };

  if (!opus.verdict) {
    const failure = describeJudgeFailure(opus);
    return {
      verdict: "NEEDS_HUMAN",
      severity: sonnet.verdict.severity,
      reasoning: `Escalated to Opus after low Sonnet confidence; ${failure.charAt(0).toLowerCase()}${failure.slice(1)}`,
      confidence: 0,
      ...combinedUsage,
      infraError: opus.infraError,
      escalatedToOpus: true,
    };
  }
  if (opus.verdict.confidence < threshold) {
    return { ...opus.verdict, verdict: "NEEDS_HUMAN", ...combinedUsage, escalatedToOpus: true };
  }
  return { ...opus.verdict, ...combinedUsage, escalatedToOpus: true };
}
