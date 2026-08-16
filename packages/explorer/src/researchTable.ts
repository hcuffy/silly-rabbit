import type { AriaNode } from "@silly-rabbit/engine";
import type { SectionElement } from "@silly-rabbit/shared";

function findFirstByRole(node: AriaNode, role: string): AriaNode | undefined {
  for (const child of node.children) {
    if (child.role === role) {
      return child;
    }
    const found = findFirstByRole(child, role);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function collectByRole(node: AriaNode, role: string, out: AriaNode[]): void {
  for (const child of node.children) {
    if (child.role === role) {
      out.push(child);
    }
    collectByRole(child, role, out);
  }
}

export function markSubtreeConsumed(node: AriaNode, consumed: Set<AriaNode>): void {
  consumed.add(node);
  for (const child of node.children) {
    markSubtreeConsumed(child, consumed);
  }
}

function tableEntityFields(tableNode: AriaNode): string[] {
  const headerRow = findFirstByRole(tableNode, "row");
  if (!headerRow) {
    return [];
  }
  const headers: AriaNode[] = [];
  collectByRole(headerRow, "columnheader", headers);
  const names = headers.map((header) => header.name).filter((name): name is string => Boolean(name));
  return names.length > 0 ? names : [];
}

export interface TableDetectionResult {
  element: SectionElement;
  entityFields: string[];
  consumedNode: AriaNode;
}

export function detectTable(tree: AriaNode): TableDetectionResult | undefined {
  const tableNode = findFirstByRole(tree, "table");
  if (tableNode) {
    return {
      element: { kind: "table", accessibleName: tableNode.name ?? "table", role: "table" },
      entityFields: tableEntityFields(tableNode),
      consumedNode: tableNode,
    };
  }

  const rows: AriaNode[] = [];
  collectByRole(tree, "row", rows);
  if (rows.length < 2) {
    return undefined;
  }

  return {
    element: { kind: "table", accessibleName: "table", role: "row" },
    entityFields: tableEntityFields(tree),
    consumedNode: tree,
  };
}

function childShapeSignature(node: AriaNode): string {
  return node.children.map((child) => child.role).join(",");
}

export interface CardDetectionResult {
  element: SectionElement;
  entityFields: string[];
  consumedNode: AriaNode;
}

function findRepeatedChildGroup(node: AriaNode): AriaNode[] | undefined {
  const bySignature = new Map<string, AriaNode[]>();
  for (const child of node.children) {
    const signature = childShapeSignature(child);
    if (!signature.includes(",")) {
      continue;
    }
    const group = bySignature.get(signature) ?? [];
    group.push(child);
    bySignature.set(signature, group);
  }
  for (const group of bySignature.values()) {
    if (group.length >= 2) {
      return group;
    }
  }
  return undefined;
}

export function detectCardGroup(tree: AriaNode): CardDetectionResult | undefined {
  const group = findRepeatedChildGroup(tree);
  if (group) {
    const [first] = group;
    if (first) {
      const entityFields = first.children.map((sub) => sub.name).filter((name): name is string => Boolean(name));
      return {
        element: { kind: "card", accessibleName: first.name ?? first.role, role: first.role },
        entityFields,
        consumedNode: tree,
      };
    }
  }

  for (const child of tree.children) {
    const found = detectCardGroup(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}
