import { TIME_PATTERNS, type AriaNode } from "@silly-rabbit/engine";
import type { SectionElement } from "@silly-rabbit/shared";

const INPUT_ROLES = new Set(["textbox", "searchbox"]);
const DROPDOWN_ROLES = new Set(["combobox", "listbox"]);
const OTHER_INTERACTIVE_ROLES = new Set(["checkbox", "radio", "switch"]);

function matchesDatePattern(text: string): boolean {
  return TIME_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(text));
}

function detectRequired(node: AriaNode): boolean | undefined {
  if (node.attrs.required === true) return true;
  if (node.name?.includes("*")) return true;
  return undefined;
}

function collectDropdownOptions(node: AriaNode): string[] | undefined {
  const options = node.children
    .filter((child) => child.role === "option")
    .map((child) => child.name)
    .filter((name): name is string => Boolean(name));
  return options.length > 0 ? options : undefined;
}

function classifyInteractiveNode(node: AriaNode): SectionElement | undefined {
  const name = node.name ?? "";
  const required = detectRequired(node);

  if (INPUT_ROLES.has(node.role) || DROPDOWN_ROLES.has(node.role)) {
    if (matchesDatePattern(name)) {
      return { kind: "dateFilter", accessibleName: name, role: node.role, ...(required ? { required } : {}) };
    }
    if (DROPDOWN_ROLES.has(node.role)) {
      const options = collectDropdownOptions(node);
      return {
        kind: "dropdown",
        accessibleName: name,
        role: node.role,
        ...(required ? { required } : {}),
        ...(options ? { options } : {}),
      };
    }
    return { kind: "input", accessibleName: name, role: node.role, ...(required ? { required } : {}) };
  }

  if (node.role === "button") {
    return { kind: "button", accessibleName: name, role: node.role };
  }

  if (OTHER_INTERACTIVE_ROLES.has(node.role)) {
    return { kind: "other", accessibleName: name, role: node.role, ...(required ? { required } : {}) };
  }

  return undefined;
}

export function walkInteractiveNodes(node: AriaNode, consumed: ReadonlySet<AriaNode>, out: SectionElement[]): void {
  for (const child of node.children) {
    if (consumed.has(child)) continue;
    const element = classifyInteractiveNode(child);
    if (element) out.push(element);
    walkInteractiveNodes(child, consumed, out);
  }
}
