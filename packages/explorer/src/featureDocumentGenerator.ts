import { DEFAULT_SONNET_MODEL, type AnthropicLike } from "@silly-rabbit/engine";
import type { Learning, ResearchInventory } from "@silly-rabbit/shared";

export interface FeatureDocumentGeneratorOptions {
  clientFactory: () => AnthropicLike;
  model?: string;
}

export interface FeatureDocumentGenerationResult {
  content: string;
  model: string;
}

const MAX_TOKENS = 2048;
const LEARNING_TYPE_ORDER: Learning["learningType"][] = ["confirmed_issue", "user_injected_check", "intended_behavior"];

function renderElementsSummary(research: ResearchInventory): string {
  if (research.elements.length === 0) {
    return "No elements recorded.";
  }
  return research.elements
    .map((element) => {
      let line = `- ${element.kind}: ${element.accessibleName} (${element.role})`;
      if (element.required) {
        line += " — required";
      }
      if (element.options) {
        line += ` — options: ${element.options.join(", ")}`;
      }
      return line;
    })
    .join("\n");
}

function renderEntityFieldsSummary(research: ResearchInventory): string {
  if (research.entityFields.length === 0) {
    return "No entity fields recorded.";
  }
  return research.entityFields.map((field) => `- ${field}`).join("\n");
}

function renderLearningsByType(activeLearnings: Learning[]): string {
  if (activeLearnings.length === 0) {
    return "No active learnings for this feature yet.";
  }

  const sections: string[] = [];
  for (const learningType of LEARNING_TYPE_ORDER) {
    const learnings = activeLearnings.filter((learning) => learning.learningType === learningType);
    if (learnings.length === 0) {
      continue;
    }
    sections.push(`${learningType}:`);
    sections.push(...learnings.map((learning) => `- ${learning.description}`));
  }
  return sections.join("\n");
}

function buildPrompt(research: ResearchInventory, activeLearnings: Learning[]): string {
  return [
    "You are documenting a feature of a web app for future maintainers. Write a concise markdown doc " +
      "covering: what this feature does, its key UI elements, and behavior that's been confirmed as " +
      "intended or flagged as a known issue. Do not include a top-level title heading — start directly " +
      "with the content.",
    "",
    `Section: ${research.sectionHeading} (${research.sectionUrl})`,
    "",
    "Elements:",
    renderElementsSummary(research),
    "",
    "Entity fields:",
    renderEntityFieldsSummary(research),
    "",
    "Active learnings:",
    renderLearningsByType(activeLearnings),
  ].join("\n");
}

export async function generateFeatureDocument(
  research: ResearchInventory,
  activeLearnings: Learning[],
  options: FeatureDocumentGeneratorOptions,
): Promise<FeatureDocumentGenerationResult> {
  const model = options.model ?? DEFAULT_SONNET_MODEL;
  const client = options.clientFactory();

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: buildPrompt(research, activeLearnings) }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return { content: textBlock?.text ?? "", model };
}
