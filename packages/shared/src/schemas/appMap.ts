import { z } from "zod";

export const AppMapScreenSchema = z.object({
  screenId: z.string(),
  normalizedUrl: z.string(),
  headingAnchor: z.string(),
  discoveredAt: z.date(),
});

export const AppMapSchema = z.object({
  id: z.string().uuid(),
  baseUrl: z.string().url(),
  screens: z.array(AppMapScreenSchema),
});

export type AppMapScreen = z.infer<typeof AppMapScreenSchema>;
export type AppMap = z.infer<typeof AppMapSchema>;
