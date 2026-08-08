import type { CharterPlan } from "./types.js";

const MOCK_LOCATIONS_PATH = "/fleet/auth/platform/locations";

export interface CharterNavConfig {
  locationsPath?: string;
}

export function resolveCharter(charter: string, nav: CharterNavConfig = {}): CharterPlan {
  if (/location/i.test(charter)) {
    return {
      name: "locations-flow",
      steps: [{ kind: "navigate", path: nav.locationsPath ?? MOCK_LOCATIONS_PATH }],
    };
  }

  throw new Error(`charter-scripted only — no LLM-driven exploration yet: "${charter}"`);
}
