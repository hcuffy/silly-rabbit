import { deriveFingerprint, deriveHeadingAnchor, normalizeUrl, parseAriaSnapshot, type AriaNode } from "@silly-rabbit/engine";
import { ResearchInventorySchema, type ResearchInventory, type SectionElement } from "@silly-rabbit/shared";
import type { Page } from "playwright";
import { walkInteractiveNodes } from "./researchClassify.js";
import { detectCardGroup, detectTable, markSubtreeConsumed } from "./researchTable.js";

async function detectLanguage(page: Page): Promise<string> {
  const lang = await page.evaluate(() => document.documentElement.lang);
  return lang && lang.trim().length > 0 ? lang : "unknown";
}

function classifySection(tree: AriaNode): { elements: SectionElement[]; entityFields: string[] } {
  const consumed = new Set<AriaNode>();
  const elements: SectionElement[] = [];
  let entityFields: string[] = [];

  const table = detectTable(tree);
  if (table) {
    elements.push(table.element);
    entityFields = table.entityFields;
    markSubtreeConsumed(table.consumedNode, consumed);
  } else {
    const card = detectCardGroup(tree);
    if (card) {
      elements.push(card.element);
      entityFields = card.entityFields;
      markSubtreeConsumed(card.consumedNode, consumed);
    }
  }

  walkInteractiveNodes(tree, consumed, elements);
  return { elements, entityFields };
}

export async function researchSection(page: Page, featureId: string): Promise<ResearchInventory> {
  const rawSnapshot = await page.ariaSnapshot({ boxes: true });
  const tree = parseAriaSnapshot(rawSnapshot);

  const [detectedLanguage, documentTitle] = await Promise.all([detectLanguage(page), page.title()]);
  const { elements, entityFields } = classifySection(tree);
  const { ariaSnapshotMasked } = deriveFingerprint(rawSnapshot);

  return ResearchInventorySchema.parse({
    featureId,
    sectionUrl: normalizeUrl(page.url()),
    sectionHeading: deriveHeadingAnchor(tree, documentTitle),
    detectedLanguage,
    elements,
    entityFields,
    ariaSnapshotMasked,
    capturedAt: new Date(),
  });
}
