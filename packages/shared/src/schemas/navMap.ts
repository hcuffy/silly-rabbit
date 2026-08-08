import { z } from "zod";
import { SectionElementSchema } from "./researchInventory.js";

export const NavMapPageStructureSchema = z.object({
  detectedLanguage: z.string(),
  elements: z.array(SectionElementSchema),
  entityFields: z.array(z.string()),
  structureFingerprint: z.string(),
  researchedAt: z.date(),
});

export const NavMapEntrySchema = z.object({
  role: z.enum(["link", "listitem", "button"]),
  label: z.string(),
  normalizedUrl: z.string().optional(),
  parentLabel: z.string().optional(),
  discoveredAt: z.date(),
  lastVerifiedAt: z.date().optional(),
  isStale: z.boolean().default(false),
  pageStructure: NavMapPageStructureSchema.optional(),
});

export const NavMapSchema = z.object({
  id: z.string().uuid(),
  baseUrl: z.string().url(),
  entries: z.array(NavMapEntrySchema),
  crawledAt: z.date(),
  crawlDurationMs: z.number(),
});

export type NavMapPageStructure = z.infer<typeof NavMapPageStructureSchema>;
export type NavMapEntry = z.infer<typeof NavMapEntrySchema>;
export type NavMap = z.infer<typeof NavMapSchema>;
