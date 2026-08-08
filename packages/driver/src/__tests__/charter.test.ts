import { describe, expect, it } from "vitest";
import { resolveCharter } from "../charter.js";

describe("resolveCharter (driver-spec §4 — charter-scripted, not LLM-chosen)", () => {
  it("resolves the locations charter to a fixed route list", () => {
    const plan = resolveCharter("test the locations flow");
    expect(plan.name).toBe("locations-flow");
    expect(plan.steps).toEqual([{ kind: "navigate", path: "/fleet/auth/platform/locations" }]);
  });

  it("throws on an unrecognized charter — no LLM-driven exploration at D3", () => {
    expect(() => resolveCharter("test the billing flow")).toThrow(/charter-scripted only/);
  });

  it("uses a nav override's locationsPath instead of the mock's fixed shape when set", () => {
    const plan = resolveCharter("test the locations flow", { locationsPath: "/custom/route" });
    expect(plan.steps).toEqual([{ kind: "navigate", path: "/custom/route" }]);
  });

  it("falls back to the mock's fixed shape when nav is passed but locationsPath is unset", () => {
    const plan = resolveCharter("test the locations flow", {});
    expect(plan.steps).toEqual([{ kind: "navigate", path: "/fleet/auth/platform/locations" }]);
  });
});
