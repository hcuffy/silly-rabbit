export interface RequiredFieldSpec {
  key: string;
  id: string;
  value: string;
}

export function findEmptyRequiredFields(fields: RequiredFieldSpec[]): Set<string> {
  return new Set(fields.filter((field) => field.value.trim() === "").map((field) => field.key));
}

export function focusFirstInvalidField(fields: RequiredFieldSpec[], invalidKeys: Set<string>): void {
  const firstInvalidField = fields.find((field) => invalidKeys.has(field.key));
  if (firstInvalidField) {
    document.getElementById(firstInvalidField.id)?.focus();
  }
}
