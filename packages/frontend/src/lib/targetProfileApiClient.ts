import { TargetProfileSchema } from "@silly-rabbit/shared";
import { z } from "zod";
import { request, reviveDates } from "./apiClient.js";

const SafeTargetProfileSchema = TargetProfileSchema.omit({ email: true, password: true });
export type SafeTargetProfile = z.infer<typeof SafeTargetProfileSchema>;

const TARGET_PROFILE_DATE_KEYS = ["createdAt", "updatedAt"] as const;

function parseSafeTargetProfile(raw: unknown): SafeTargetProfile {
  return SafeTargetProfileSchema.parse(reviveDates(raw as Record<string, unknown>, TARGET_PROFILE_DATE_KEYS));
}

export const TargetProfileWriteInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  baseUrl: z.string().trim().url("Base URL must be a valid URL."),
  loginUrl: z.string().trim().url("Login URL must be a valid URL.").optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  emailSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
  nextSelector: z.string().optional(),
  timeoutMs: z.number().optional(),
  locationsPath: z.string().optional(),
  allowedDomains: z.array(z.string()).min(1, "At least one allowed domain is required."),
});
export type TargetProfileWriteInput = z.infer<typeof TargetProfileWriteInputSchema>;

export const TargetProfilePatchInputSchema = TargetProfileWriteInputSchema.partial();
export type TargetProfilePatchInput = z.infer<typeof TargetProfilePatchInputSchema>;

export async function listTargetProfiles(): Promise<SafeTargetProfile[]> {
  const response = await request("/target-profiles");
  const body = (await response.json()) as unknown[];
  return body.map(parseSafeTargetProfile);
}

export async function getActiveTargetProfileId(): Promise<string | null> {
  const response = await request("/target-profiles/active");
  const body = (await response.json()) as { profileId: string | null };
  return body.profileId;
}

export async function createTargetProfile(input: TargetProfileWriteInput): Promise<SafeTargetProfile> {
  const parsedInput = TargetProfileWriteInputSchema.parse(input);
  const response = await request("/target-profiles", { method: "POST", body: JSON.stringify(parsedInput) });
  return parseSafeTargetProfile(await response.json());
}

export async function updateTargetProfile(id: string, patch: TargetProfilePatchInput): Promise<SafeTargetProfile> {
  const parsedPatch = TargetProfilePatchInputSchema.parse(patch);
  const response = await request(`/target-profiles/${id}`, { method: "PUT", body: JSON.stringify(parsedPatch) });
  return parseSafeTargetProfile(await response.json());
}

export async function deleteTargetProfile(id: string): Promise<void> {
  await request(`/target-profiles/${id}`, { method: "DELETE" });
}

export async function activateTargetProfile(id: string): Promise<void> {
  await request(`/target-profiles/${id}/activate`, { method: "POST" });
}

export async function deactivateTargetProfile(): Promise<void> {
  await request("/target-profiles/active", { method: "DELETE" });
}
