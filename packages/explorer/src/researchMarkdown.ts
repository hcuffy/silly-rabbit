import type { ResearchInventory, SectionElement } from "@silly-rabbit/shared";

function renderElementLine(element: SectionElement): string {
  const requiredTag = element.required ? " (required)" : "";
  const optionsTag = element.options ? ` — options: ${element.options.join(", ")}` : "";
  return `- **${element.kind}**: ${element.accessibleName} (\`${element.role}\`)${requiredTag}${optionsTag}`;
}

export function renderResearchMarkdown(inventory: ResearchInventory): string {
  const lines = [
    `# Research: ${inventory.sectionHeading}`,
    "",
    `- Section URL: ${inventory.sectionUrl}`,
    `- Detected language: ${inventory.detectedLanguage}`,
    `- Captured at: ${inventory.capturedAt.toISOString()}`,
    "",
    "## Elements",
    ...inventory.elements.map(renderElementLine),
    "",
    "## Entity fields",
    ...inventory.entityFields.map((field) => `- ${field}`),
  ];
  return lines.join("\n");
}
