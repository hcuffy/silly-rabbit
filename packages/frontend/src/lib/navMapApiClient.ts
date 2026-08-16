import { z } from "zod";
import { ApiError, request } from "./apiClient.js";

const NavMapEntryDisplaySchema = z.object({
  role: z.enum(["link", "listitem", "button"]),
  label: z.string(),
  normalizedUrl: z.string().optional(),
  parentLabel: z.string().optional(),
  isStale: z.boolean(),
});
export type NavMapEntryDisplay = z.infer<typeof NavMapEntryDisplaySchema>;

const NavMapDisplaySchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  entries: z.array(NavMapEntryDisplaySchema),
  crawledAt: z.string(),
  crawlDurationMs: z.number(),
});
export type NavMapDisplay = z.infer<typeof NavMapDisplaySchema>;

function parseNavMapDisplay(raw: unknown): NavMapDisplay {
  return NavMapDisplaySchema.parse(raw);
}

export async function crawlNavMap(baseUrl: string): Promise<NavMapDisplay> {
  const response = await request("/nav-map/crawl", { method: "POST", body: JSON.stringify({ baseUrl }) });
  return parseNavMapDisplay(await response.json());
}

export async function getNavMap(baseUrl: string): Promise<NavMapDisplay | null> {
  try {
    const response = await request(`/nav-map?baseUrl=${encodeURIComponent(baseUrl)}`);
    return parseNavMapDisplay(await response.json());
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function deleteNavMap(baseUrl: string): Promise<void> {
  await request(`/nav-map?baseUrl=${encodeURIComponent(baseUrl)}`, { method: "DELETE" });
}
