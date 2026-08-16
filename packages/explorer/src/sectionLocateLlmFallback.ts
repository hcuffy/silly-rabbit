import { DEFAULT_SONNET_MODEL, type AnthropicLike } from "@silly-rabbit/engine";
import { z } from "zod";
import type { ToolInputSchema } from "./anthropicToolSchema.js";

export interface SectionCandidate {
  role: string;
  label: string;
}

export interface SectionLlmMatchResult {
  matchedLabel?: string;
  confidence: number;
}

export interface SectionLlmMatchOptions {
  clientFactory: () => AnthropicLike;
  model?: string;
}

const MATCH_TOOL_NAME = "submit_section_match";
const NO_MATCH_LABEL = "NO_MATCH";
const MAX_TOKENS = 256;
const PRIVATE_USE_AREA_ICON_GLYPH_PATTERN = /[\u{E000}-\u{F8FF}]/gu;

export function normalizeLabelForLlmMatchComparison(label: string): string {
  return label.replace(PRIVATE_USE_AREA_ICON_GLYPH_PATTERN, "").trim();
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MatchInputSchema = z.object({
  matchedLabel: z.string(),
  confidence: z.number().min(0).max(1),
});

function buildTool(candidateLabels: string[]): { name: string; description: string; input_schema: ToolInputSchema } {
  return {
    name: MATCH_TOOL_NAME,
    description:
      "Pick the one candidate navigation label that best matches the described section, even if the " +
      "description and the label are in different languages. Return the no-match value if none genuinely correspond.",
    input_schema: {
      type: "object",
      properties: {
        matchedLabel: {
          type: "string",
          enum: [...candidateLabels, NO_MATCH_LABEL],
          description: "Exactly one of the provided candidate labels, verbatim, or the no-match value.",
        },
        confidence: { type: "number", description: "Calibrated confidence in [0,1] that matchedLabel is correct." },
      },
      required: ["matchedLabel", "confidence"],
      additionalProperties: false,
    },
  };
}

function buildPrompt(sectionDescription: string, candidateLabels: string[]): string {
  return [
    `A user described a section of a web app they want to test: "${sectionDescription}"`,
    "The app's real navigation exposes these candidate labels verbatim, in whatever language the app is rendered in:",
    candidateLabels.map((label) => `- ${label}`).join("\n"),
    `Pick the one candidate that best corresponds to the described section — the description may be in a ` +
      `different language than the label. If none plausibly correspond, return "${NO_MATCH_LABEL}" rather than guessing.`,
    "Submit your answer via the tool.",
  ].join("\n\n");
}

export async function matchSectionWithLlm(
  sectionDescription: string,
  candidates: SectionCandidate[],
  options: SectionLlmMatchOptions,
): Promise<SectionLlmMatchResult> {
  if (candidates.length === 0) {
    return { confidence: 0 };
  }

  const model = options.model ?? DEFAULT_SONNET_MODEL;
  const candidateLabels = candidates.map((candidate) => candidate.label);

  try {
    const response = await options.clientFactory().messages.create({
      model,
      max_tokens: MAX_TOKENS,
      tools: [buildTool(candidateLabels)],
      tool_choice: { type: "tool", name: MATCH_TOOL_NAME },
      messages: [{ role: "user", content: buildPrompt(sectionDescription, candidateLabels) }],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use" && block.name === MATCH_TOOL_NAME);
    const parsed = toolUse ? MatchInputSchema.safeParse(toolUse.input) : undefined;
    if (!parsed?.success) {
      return { confidence: 0 };
    }

    const { matchedLabel, confidence } = parsed.data;
    if (matchedLabel === NO_MATCH_LABEL) {
      return { confidence };
    }

    const normalizedMatch = normalizeLabelForLlmMatchComparison(matchedLabel);
    const isRealCandidate = candidateLabels.some((label) => normalizeLabelForLlmMatchComparison(label) === normalizedMatch);
    if (!isRealCandidate) {
      return { confidence };
    }
    return { matchedLabel, confidence };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `sectionLocate LLM fallback: ${model} unavailable — section-matching falls back to exact-match only, ` +
        `this fuzzy-match attempt returns no match. Set ANTHROPIC_API_KEY to enable fuzzy section matching ` +
        `(or check network/rate-limits if a key is already configured). Detail: ${message}`,
    );
    return { confidence: 0 };
  }
}
