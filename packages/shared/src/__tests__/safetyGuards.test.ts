import { describe, expect, it } from "vitest";
import { parseProductionUrlPatterns } from "../safetyGuards.js";

describe("parseProductionUrlPatterns (moved from backend/driver duplicates into the single shared implementation)", () => {
  it("parses a comma-separated plain-hostname list, not regex — each entry becomes an exact-match pattern", () => {
    const patterns = parseProductionUrlPatterns("app.example.com,example.com");
    expect(patterns).toHaveLength(2);
    expect(patterns[0]?.test("app.example.com")).toBe(true);
    expect(patterns[1]?.test("example.com")).toBe(true);
  });

  it("matches only the exact host — not a subdomain of it, not a superstring containing it", () => {
    const [pattern] = parseProductionUrlPatterns("example.com");
    expect(pattern?.test("example.com")).toBe(true);
    expect(pattern?.test("dev.example.com")).toBe(false);
    expect(pattern?.test("example.com.evil.com")).toBe(false);
  });

  it("an unset or empty env value parses to an empty list (no-op, preserved from before)", () => {
    expect(parseProductionUrlPatterns(undefined)).toEqual([]);
    expect(parseProductionUrlPatterns("")).toEqual([]);
  });
});
