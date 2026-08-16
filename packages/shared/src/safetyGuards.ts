export type SafetyGuardName = "ALLOWLIST" | "PROD_URL" | "DESTRUCTIVE_ACTION";

export class SafetyViolation extends Error {
  readonly guard: SafetyGuardName;

  constructor(guard: SafetyGuardName, message: string) {
    super(message);
    this.name = "SafetyViolation";
    this.guard = guard;
  }
}

export interface ActionDescriptor {
  role: string;
  accessibleName: string;
}

export function parseAllowedDomains(environmentValue: string | undefined): string[] {
  return (environmentValue ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function escapeRegExpChars(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseProductionUrlPatterns(environmentValue: string | undefined): RegExp[] {
  return (environmentValue ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((hostname) => new RegExp(`^${escapeRegExpChars(hostname)}$`, "i"));
}

export const DEFAULT_DESTRUCTIVE_PATTERNS: readonly string[] = [
  "delete",
  "remove",
  "pay",
  "purchase",
  "confirm",
  "cancel",
  "charge",
  "submit order",
  "place order",
];

const ACTIONABLE_ROLES = new Set(["button", "link"]);

function toWordBoundaryPattern(phrase: string): RegExp {
  const escaped = escapeRegExpChars(phrase).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

export function assertAllowedUrl(url: string, allowedHosts: readonly string[]): void {
  const host = new URL(url).host.toLowerCase();
  const allowed = new Set(allowedHosts.map((entry) => entry.toLowerCase()));
  if (!allowed.has(host)) {
    throw new SafetyViolation("ALLOWLIST", `host "${host}" is not on the domain allowlist (url: ${url})`);
  }
}

export function assertNotProductionUrl(url: string, productionUrlPatterns: readonly RegExp[]): void {
  const host = new URL(url).host.toLowerCase();
  const matched = productionUrlPatterns.find((pattern) => pattern.test(host));
  if (matched) {
    throw new SafetyViolation("PROD_URL", `host "${host}" matches a production-url pattern (${matched.source})`);
  }
}

export function assertNotDestructive(action: ActionDescriptor, destructivePatterns: readonly string[] = DEFAULT_DESTRUCTIVE_PATTERNS): void {
  if (!ACTIONABLE_ROLES.has(action.role)) {
    return;
  }

  const matched = destructivePatterns.find((phrase) => toWordBoundaryPattern(phrase).test(action.accessibleName));
  if (matched) {
    throw new SafetyViolation(
      "DESTRUCTIVE_ACTION",
      `action "${action.accessibleName}" (role: ${action.role}) matches destructive pattern "${matched}"`,
    );
  }
}
