import { describe, expect, it } from "vitest";
import { ResearchInventorySchema, SectionElementSchema } from "../researchInventory.js";

describe("SectionElementSchema", () => {
  it("parses a valid element with all optional fields present", () => {
    const result = SectionElementSchema.parse({
      kind: "dropdown",
      accessibleName: "Status",
      role: "combobox",
      required: true,
      options: ["Active", "Inactive"],
    });
    expect(result.kind).toBe("dropdown");
  });

  it("parses a valid element with optional fields omitted (required/options)", () => {
    const result = SectionElementSchema.parse({
      kind: "button",
      accessibleName: "Save",
      role: "button",
    });
    expect(result.required).toBeUndefined();
    expect(result.options).toBeUndefined();
  });

  it("rejects an element with an unknown kind", () => {
    expect(() =>
      SectionElementSchema.parse({
        kind: "not-a-real-kind",
        accessibleName: "Save",
        role: "button",
      }),
    ).toThrow();
  });
});

describe("ResearchInventorySchema", () => {
  it("parses a valid research inventory", () => {
    const result = ResearchInventorySchema.parse({
      featureId: "locations",
      sectionUrl: "https://dev.rabbit.example/fleet/locations",
      sectionHeading: "Locations",
      detectedLanguage: "en",
      elements: [{ kind: "table", accessibleName: "Locations table", role: "table" }],
      entityFields: ["Name", "Address"],
      ariaSnapshotMasked: "- table\n  - row",
      capturedAt: new Date(),
    });
    expect(result.elements).toHaveLength(1);
  });

  it("rejects a research inventory missing required fields", () => {
    expect(() =>
      ResearchInventorySchema.parse({
        featureId: "locations",
        sectionHeading: "Locations",
        detectedLanguage: "en",
        elements: [],
        entityFields: [],
        ariaSnapshotMasked: "",
        capturedAt: new Date(),
      }),
    ).toThrow();
  });
});
