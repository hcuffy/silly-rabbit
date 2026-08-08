import { randomBytes } from "node:crypto";
import type { ResearchInventory } from "@silly-rabbit/shared";

const EXCLUDED_FIELD_NAME_PATTERN = /password|token|auth|route|url|email/i;

export function generateMarker(): string {
  return `silly-rabbit-test-${randomBytes(4).toString("hex")}`;
}

export function selectFreeTextField(
  inputValues: Record<string, string>,
  research: ResearchInventory,
): string | undefined {
  for (const fieldName of Object.keys(inputValues)) {
    if (EXCLUDED_FIELD_NAME_PATTERN.test(fieldName)) continue;
    const element = research.elements.find((candidate) => candidate.accessibleName === fieldName);
    if (element?.kind === "input") return fieldName;
  }
  return undefined;
}

export function injectMarker(
  inputValues: Record<string, string>,
  fieldName: string,
  marker: string,
): Record<string, string> {
  const existingValue = inputValues[fieldName] ?? "";
  return { ...inputValues, [fieldName]: `${marker} ${existingValue}`.trim() };
}
