import type { ResearchInventory } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { renderResearchMarkdown } from "../researchMarkdown.js";

function inventory(overrides: Partial<ResearchInventory> = {}): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [{ kind: "input", accessibleName: "Search", role: "textbox", required: true }],
    entityFields: ["Name", "City"],
    ariaSnapshotMasked: "- table",
    capturedAt: new Date("2026-07-25T15:40:04Z"),
    ...overrides,
  };
}

describe("renderResearchMarkdown (explorer-spec §4.1 — pure view, not the source of truth)", () => {
  it("renders a deterministic markdown view of the inventory", () => {
    const markdown = renderResearchMarkdown(inventory());
    expect(markdown).toContain("# Research: Locations");
    expect(markdown).toContain("Detected language: en");
    expect(markdown).toContain("**input**: Search (`textbox`) (required)");
    expect(markdown).toContain("- Name");
    expect(markdown).toContain("- City");
  });

  it("is a pure function — same input always produces the same output", () => {
    const record = inventory();
    expect(renderResearchMarkdown(record)).toBe(renderResearchMarkdown(record));
  });
});
