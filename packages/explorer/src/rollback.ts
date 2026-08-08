import { parseAriaSnapshot, type AriaNode } from "@silly-rabbit/engine";
import type { ActionDescriptor } from "@silly-rabbit/driver";
import type { Page } from "playwright";
import { collectByRole, detectCardGroup, detectTable } from "./researchTable.js";
import type { PlaywrightRole } from "./happyPathExecutor.js";

export type RollbackLocator =
  | { kind: "marker"; marker: string }
  | { kind: "fieldMatch"; inputValues: Record<string, string>; window: { from: Date; to: Date } };

export type RollbackResult = { status: "OK" } | { status: "FAILED"; reason: string };

export interface RollbackOptions {
  onBeforeRollbackDelete?: (action: ActionDescriptor, verifiedMarkerMatch: boolean) => Promise<void> | void;
}

const DELETE_AFFORDANCE_PATTERN = /delete|remove|trash/i;

function isHeaderRow(row: AriaNode): boolean {
  return row.children.length > 0 && row.children.every((child) => child.role === "columnheader");
}

function findCandidateRows(tree: AriaNode): { role: string; nodes: AriaNode[] } | undefined {
  const table = detectTable(tree);
  if (table) {
    const rowRole = table.element.role === "table" ? "row" : table.element.role;
    const rows: AriaNode[] = [];
    collectByRole(table.consumedNode, rowRole, rows);
    return { role: rowRole, nodes: rows.filter((row) => !isHeaderRow(row)) };
  }

  const card = detectCardGroup(tree);
  if (card) {
    const nodes: AriaNode[] = [];
    collectByRole(card.consumedNode, card.element.role, nodes);
    return { role: card.element.role, nodes };
  }

  return undefined;
}

function collectLeafTexts(node: AriaNode, out: string[]): void {
  if (node.name) out.push(node.name);
  for (const child of node.children) collectLeafTexts(child, out);
}

function matchesMarker(row: AriaNode, marker: string): boolean {
  const texts: string[] = [];
  collectLeafTexts(row, texts);
  return texts.some((text) => text.includes(marker));
}

function matchesFieldValues(row: AriaNode, inputValues: Record<string, string>): boolean {
  const values = Object.values(inputValues);
  if (values.length === 0) return false;
  const texts: string[] = [];
  collectLeafTexts(row, texts);
  return values.every((value) => texts.includes(value));
}

function matchesLocator(row: AriaNode, locator: RollbackLocator): boolean {
  return locator.kind === "marker" ? matchesMarker(row, locator.marker) : matchesFieldValues(row, locator.inputValues);
}

function findDeleteButtonName(row: AriaNode): string | undefined {
  const buttons: AriaNode[] = [];
  collectByRole(row, "button", buttons);
  return buttons.find((button) => button.name && DELETE_AFFORDANCE_PATTERN.test(button.name))?.name;
}

async function locateCandidates(page: Page, locator: RollbackLocator): Promise<{ role: string; nodes: AriaNode[] }> {
  const snapshot = await page.ariaSnapshot({ boxes: true });
  const tree = parseAriaSnapshot(snapshot);
  const found = findCandidateRows(tree);
  if (!found) return { role: "row", nodes: [] };
  return { role: found.role, nodes: found.nodes.filter((row) => matchesLocator(row, locator)) };
}

export async function rollback(page: Page, locator: RollbackLocator, options: RollbackOptions = {}): Promise<RollbackResult> {
  const candidates = await locateCandidates(page, locator);
  if (candidates.nodes.length === 0) return { status: "FAILED", reason: "row not found" };
  if (candidates.nodes.length > 1) return { status: "FAILED", reason: "ambiguous match" };

  const [row] = candidates.nodes;
  const deleteButtonName = row ? findDeleteButtonName(row) : undefined;
  if (!row || !deleteButtonName) return { status: "FAILED", reason: "row not found" };

  const identifyingTexts = locator.kind === "marker" ? [locator.marker] : Object.values(locator.inputValues);
  let rowLocator = page.getByRole(candidates.role as PlaywrightRole);
  for (const text of identifyingTexts) rowLocator = rowLocator.filter({ hasText: text });

  const action: ActionDescriptor = { role: "button", accessibleName: deleteButtonName };
  await options.onBeforeRollbackDelete?.(action, true);
  await rowLocator.getByRole("button", { name: deleteButtonName }).click();

  const confirmButton = page.getByRole("button", { name: /confirm|yes|ok/i }).first();
  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click();
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);

  const verified = await locateCandidates(page, locator);
  return verified.nodes.length > 0 ? { status: "FAILED", reason: "delete did not take effect" } : { status: "OK" };
}
