import type { NavigationGuardOptions } from "@silly-rabbit/driver";
import { assertAllowedUrl, assertNotProductionUrl, SafetyViolation, type ActionDescriptor } from "@silly-rabbit/shared";

export { assertAllowedUrl, assertNotProductionUrl, SafetyViolation, type ActionDescriptor };
export {
  assertNotDestructive,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  parseAllowedDomains,
  parseProductionUrlPatterns,
  type SafetyGuardName,
} from "@silly-rabbit/shared";

export function warnIfAllowedDomainsEmpty(allowedDomains: readonly string[]): void {
  if (allowedDomains.length === 0) {
    console.warn(
      "WARNING: ALLOWED_DOMAINS is empty — every run against a real target will fail its first safety " +
        "check (ALLOWLIST violation). Set ALLOWED_DOMAINS in .env before triggering a real-target run. " +
        "(The bundled zero-config mock-target demo is unaffected — it never reaches this check.)",
    );
  }
}

export function assertRollbackDeleteAllowed(action: ActionDescriptor, verifiedMarkerMatch: boolean): void {
  if (verifiedMarkerMatch) {
    return;
  }
  throw new SafetyViolation(
    "DESTRUCTIVE_ACTION",
    `rollback delete click on "${action.accessibleName}" (role: ${action.role}) was not verified against ` +
      "this run's marker/field match — refusing",
  );
}

export function buildNavigationAllowedCheck(
  allowedDomains: readonly string[],
  productionUrlPatterns: readonly RegExp[],
): NavigationGuardOptions["isNavigationAllowed"] {
  return (url) => {
    try {
      assertAllowedUrl(url, allowedDomains);
      assertNotProductionUrl(url, productionUrlPatterns);
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
}
