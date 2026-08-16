import { buildTargetProfileOverrides, type TargetProfileOverrides } from "@silly-rabbit/shared";
import type { ActiveTargetProfileRepo } from "./repos/activeTargetProfileRepo.js";
import type { TargetProfileRepo } from "./repos/targetProfileRepo.js";

export async function resolveActiveProfileOverrides(
  activeTargetProfileRepo: ActiveTargetProfileRepo,
  targetProfileRepo: TargetProfileRepo,
): Promise<Partial<TargetProfileOverrides>> {
  const pointer = await activeTargetProfileRepo.get();
  if (!pointer) {
    return {};
  }

  const profile = await targetProfileRepo.get(pointer.profileId);
  if (!profile) {
    return {};
  }

  return buildTargetProfileOverrides(profile);
}

export async function resolveProfileOverridesById(targetProfileRepo: TargetProfileRepo, profileId: string): Promise<TargetProfileOverrides> {
  const profile = await targetProfileRepo.get(profileId);
  if (!profile) {
    throw new Error(`target profile not found: ${profileId}`);
  }
  return buildTargetProfileOverrides(profile);
}

interface ProfileResolutionDeps {
  activeTargetProfileRepo?: ActiveTargetProfileRepo;
  targetProfileRepo?: TargetProfileRepo;
}

export async function withActiveProfileOverrides<T extends ProfileResolutionDeps>(deps: T): Promise<T & Partial<TargetProfileOverrides>> {
  if (!deps.activeTargetProfileRepo || !deps.targetProfileRepo) {
    return deps;
  }

  const overrides = await resolveActiveProfileOverrides(deps.activeTargetProfileRepo, deps.targetProfileRepo);
  return { ...deps, ...overrides };
}

export interface ResolvedActiveProfileRequest<T> {
  activeProfileBaseUrl: string | undefined;
  deps: T & Partial<TargetProfileOverrides>;
}

export async function resolveActiveProfileForRequest<T extends ProfileResolutionDeps>(deps: T): Promise<ResolvedActiveProfileRequest<T>> {
  if (!deps.activeTargetProfileRepo || !deps.targetProfileRepo) {
    return { activeProfileBaseUrl: undefined, deps };
  }

  const overrides = await resolveActiveProfileOverrides(deps.activeTargetProfileRepo, deps.targetProfileRepo);
  return { activeProfileBaseUrl: overrides.baseUrl, deps: { ...deps, ...overrides } };
}
