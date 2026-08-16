import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAllowedUrl,
  assertNotDestructive,
  assertNotProductionUrl,
  assertRollbackDeleteAllowed,
  buildNavigationAllowedCheck,
  DEFAULT_DESTRUCTIVE_PATTERNS,
  parseAllowedDomains,
  parseProductionUrlPatterns,
  SafetyViolation,
  warnIfAllowedDomainsEmpty,
} from "../safety.js";

describe("assertAllowedUrl (safety-spec §3)", () => {
  it("passes for a host on the allowlist", () => {
    expect(() => assertAllowedUrl("https://dev.rabbit.example/path", ["dev.rabbit.example"])).not.toThrow();
  });

  it("throws SafetyViolation for a host not on the allowlist", () => {
    expect(() => assertAllowedUrl("https://other.example", ["dev.rabbit.example"])).toThrow(SafetyViolation);
  });

  it("never substring-matches — a lookalike host must not pass", () => {
    expect(() => assertAllowedUrl("https://evil-rabbit.com", ["rabbit.com"])).toThrow(SafetyViolation);
    expect(() => assertAllowedUrl("https://rabbit.com.evil.com", ["rabbit.com"])).toThrow(SafetyViolation);
  });

  it("is case-insensitive on the host", () => {
    expect(() => assertAllowedUrl("https://DEV.rabbit.Example", ["dev.rabbit.example"])).not.toThrow();
  });

  it("matches host+port, not just hostname", () => {
    expect(() => assertAllowedUrl("http://localhost:5055", ["localhost:5055"])).not.toThrow();
    expect(() => assertAllowedUrl("http://localhost:9999", ["localhost:5055"])).toThrow(SafetyViolation);
  });

  it("an empty allowlist refuses everything (fail-closed)", () => {
    expect(() => assertAllowedUrl("https://dev.rabbit.example", [])).toThrow(SafetyViolation);
  });

  it("the thrown violation carries the ALLOWLIST guard name", () => {
    try {
      assertAllowedUrl("https://other.example", ["dev.rabbit.example"]);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SafetyViolation);
      expect((error as SafetyViolation).guard).toBe("ALLOWLIST");
    }
  });
});

describe("assertNotProductionUrl (safety-spec §4)", () => {
  const productionPatterns = [/^app\.rabbit\.com$/i, /^rabbit\.com$/i];

  it("passes for a dev/staging host", () => {
    expect(() => assertNotProductionUrl("https://dev.rabbit.example", productionPatterns)).not.toThrow();
  });

  it("throws for a host matching a prod pattern, even if it would be allowlisted", () => {
    expect(() => assertNotProductionUrl("https://app.rabbit.com", productionPatterns)).toThrow(SafetyViolation);
  });

  it("an empty pattern list refuses nothing (allowlist stays authoritative)", () => {
    expect(() => assertNotProductionUrl("https://app.rabbit.com", [])).not.toThrow();
  });
});

describe("assertNotDestructive (safety-spec §5)", () => {
  it("throws for Delete/Pay/Confirm-style accessible names on actionable roles", () => {
    expect(() => assertNotDestructive({ role: "button", accessibleName: "Delete" })).toThrow(SafetyViolation);
    expect(() => assertNotDestructive({ role: "link", accessibleName: "Pay now" })).toThrow(SafetyViolation);
    expect(() => assertNotDestructive({ role: "button", accessibleName: "Confirm" })).toThrow(SafetyViolation);
    expect(() => assertNotDestructive({ role: "button", accessibleName: "Place order" })).toThrow(SafetyViolation);
  });

  it("matches on word boundary, not substring", () => {
    expect(() => assertNotDestructive({ role: "button", accessibleName: "Paying customers" })).not.toThrow();
    expect(() => assertNotDestructive({ role: "button", accessibleName: "Removable storage" })).not.toThrow();
  });

  it("benign labels pass", () => {
    expect(() => assertNotDestructive({ role: "link", accessibleName: "Main Warehouse" })).not.toThrow();
    expect(() => assertNotDestructive({ role: "button", accessibleName: "View details" })).not.toThrow();
  });

  it("only guards actionable roles (button/link) — a heading is never a mutating action", () => {
    expect(() => assertNotDestructive({ role: "heading", accessibleName: "Delete confirmation" })).not.toThrow();
  });

  it("accepts a custom pattern list, defaulting to DEFAULT_DESTRUCTIVE_PATTERNS", () => {
    expect(() => assertNotDestructive({ role: "button", accessibleName: "Launch" }, ["launch"])).toThrow(SafetyViolation);
    expect(DEFAULT_DESTRUCTIVE_PATTERNS).toContain("delete");
  });
});

describe("assertRollbackDeleteAllowed (explorer-spec §9/§13.9 — narrowly-scoped rollback exception)", () => {
  it("permits a delete click only when the caller has already verified the marker/field match", () => {
    expect(() => assertRollbackDeleteAllowed({ role: "button", accessibleName: "Delete" }, true)).not.toThrow();
  });

  it("refuses an unverified delete click, even though the whole point of this function is to allow deletes", () => {
    expect(() => assertRollbackDeleteAllowed({ role: "button", accessibleName: "Delete" }, false)).toThrow(SafetyViolation);
  });

  it("the thrown violation carries the DESTRUCTIVE_ACTION guard name, same taxonomy as assertNotDestructive", () => {
    try {
      assertRollbackDeleteAllowed({ role: "button", accessibleName: "Delete" }, false);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SafetyViolation);
      expect((error as SafetyViolation).guard).toBe("DESTRUCTIVE_ACTION");
    }
  });

  it("is a distinct function from assertNotDestructive — a non-destructive-looking name is still refused when unverified", () => {
    expect(() => assertRollbackDeleteAllowed({ role: "button", accessibleName: "Save" }, false)).toThrow(SafetyViolation);
    expect(() => assertNotDestructive({ role: "button", accessibleName: "Save" })).not.toThrow();
  });
});

describe(
  "buildNavigationAllowedCheck (single source of truth for the request-level navigation guard's predicate — " +
    "same functions as onBeforeNavigate, not a second copy)",
  () => {
    it("allows a host that is allowlisted and not a production pattern", () => {
      const isAllowed = buildNavigationAllowedCheck(["dev.rabbit.example"], []);
      expect(isAllowed("https://dev.rabbit.example/path")).toEqual({ allowed: true });
    });

    it("refuses a host that is off the allowlist, with a reason", () => {
      const isAllowed = buildNavigationAllowedCheck(["dev.rabbit.example"], []);
      const result = isAllowed("https://other.example/path");
      expect(result.allowed).toBe(false);
      expect(!result.allowed && result.reason).toContain("not on the domain allowlist");
    });

    it("refuses an allowlisted host that also matches a production-url pattern", () => {
      const isAllowed = buildNavigationAllowedCheck(["rabbit.com"], [/^rabbit\.com$/i]);
      const result = isAllowed("https://rabbit.com/path");
      expect(result.allowed).toBe(false);
      expect(!result.allowed && result.reason).toContain("production-url pattern");
    });

    it("never throws — always returns the {allowed, reason} shape, even for a refused url", () => {
      const isAllowed = buildNavigationAllowedCheck([], []);
      expect(() => isAllowed("https://anything.example")).not.toThrow();
    });
  },
);

describe("parseAllowedDomains / parseProductionUrlPatterns (env parsing)", () => {
  it("parses a comma-separated, trimmed, lowercased host list", () => {
    expect(parseAllowedDomains(" Dev.Example.com , localhost:5055 ")).toEqual(["dev.example.com", "localhost:5055"]);
  });

  it("an unset env value parses to an empty list", () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
  });

  it("parses a comma-separated plain-hostname list, not regex — each entry becomes an exact-match pattern", () => {
    const patterns = parseProductionUrlPatterns("app.example.com,example.com");
    expect(patterns).toHaveLength(2);
    expect(patterns[0]?.test("app.example.com")).toBe(true);
    expect(patterns[1]?.test("example.com")).toBe(true);
  });

  it("matches only the exact host — not a subdomain of it", () => {
    const [pattern] = parseProductionUrlPatterns("example.com");
    expect(pattern?.test("example.com")).toBe(true);
    expect(pattern?.test("dev.example.com")).toBe(false);
  });

  it("matches only the exact host — not a superstring containing it", () => {
    const [pattern] = parseProductionUrlPatterns("example.com");
    expect(pattern?.test("example.com.evil.com")).toBe(false);
    expect(pattern?.test("evil-example.com")).toBe(false);
  });

  it("the literal dot in a hostname is escaped, not treated as regex any-character", () => {
    const [pattern] = parseProductionUrlPatterns("example.com");
    expect(pattern?.test("exampleXcom")).toBe(false);
  });

  it("an unset or empty env value parses to an empty list (no-op, preserved from before)", () => {
    expect(parseProductionUrlPatterns(undefined)).toEqual([]);
    expect(parseProductionUrlPatterns("")).toEqual([]);
  });

  it(
    "this is exactly the fix for the real config bug found earlier: an unanchored bare-domain pattern used " +
      "to match a multi-label dev host as a substring — plain-hostname input closes that",
    () => {
      const [pattern] = parseProductionUrlPatterns("prod.example.com");
      expect(pattern?.test("staging.dev.prod.example.com")).toBe(false);
    },
  );
});

describe("warnIfAllowedDomainsEmpty (onboarding-friction fix)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a loud warning naming the real consequence when the allowlist is empty", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnIfAllowedDomainsEmpty([]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain("ALLOWED_DOMAINS is empty");
    expect(message).toContain("every run against a real target will fail its first safety check");
  });

  it("stays silent when the allowlist has at least one entry", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnIfAllowedDomainsEmpty(["dev.rabbit.example"]);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
