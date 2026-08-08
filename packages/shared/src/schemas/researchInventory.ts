import { z } from "zod";

export const SectionElementSchema = z.object({
  kind: z.enum(["input", "dropdown", "dateFilter", "table", "card", "button", "other"]),
  accessibleName: z.string(),
  role: z.string(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

export const ResearchInventorySchema = z.object({
  featureId: z.string(),
  sectionUrl: z.string(),
  sectionHeading: z.string(),
  detectedLanguage: z.string(),
  elements: z.array(SectionElementSchema),
  entityFields: z.array(z.string()),
  ariaSnapshotMasked: z.string(),
  capturedAt: z.date(),
});

export type SectionElement = z.infer<typeof SectionElementSchema>;
export type ResearchInventory = z.infer<typeof ResearchInventorySchema>;
