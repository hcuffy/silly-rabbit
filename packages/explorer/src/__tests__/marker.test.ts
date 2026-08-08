import type { ResearchInventory } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { generateMarker, injectMarker, selectFreeTextField } from "../marker.js";

function research(overrides: Partial<ResearchInventory> = {}): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [
      { kind: "input", accessibleName: "Name", role: "textbox" },
      { kind: "input", accessibleName: "Email", role: "textbox" },
      { kind: "dropdown", accessibleName: "Region", role: "combobox" },
      { kind: "button", accessibleName: "Save", role: "button" },
    ],
    entityFields: [],
    ariaSnapshotMasked: "- heading",
    capturedAt: new Date(),
    ...overrides,
  };
}

describe("generateMarker (explorer-spec §8.5)", () => {
  it("produces a silly-rabbit-test-<8 hex chars> token", () => {
    expect(generateMarker()).toMatch(/^silly-rabbit-test-[0-9a-f]{8}$/);
  });

  it("is collision-resistant across repeated calls", () => {
    const markers = new Set(Array.from({ length: 50 }, () => generateMarker()));
    expect(markers.size).toBe(50);
  });
});

describe("selectFreeTextField (explorer-spec §8.5)", () => {
  it("picks a free-text ('input' kind) field from inputValues", () => {
    const field = selectFreeTextField({ Name: "Acme", Region: "West" }, research());
    expect(field).toBe("Name");
  });

  it("never selects a field affecting routing/auth/destructive semantics, even if kind is input", () => {
    const field = selectFreeTextField({ Email: "a@b.com" }, research());
    expect(field).toBeUndefined();
  });

  it("returns undefined when no field in inputValues is free-text-capable", () => {
    const field = selectFreeTextField({ Region: "West" }, research());
    expect(field).toBeUndefined();
  });

  it("returns undefined for a field not present in the research inventory", () => {
    const field = selectFreeTextField({ Ghost: "x" }, research());
    expect(field).toBeUndefined();
  });
});

describe("injectMarker (explorer-spec §8.5)", () => {
  it("prefixes the marker into the field's existing value, not replacing it", () => {
    const result = injectMarker({ Name: "Test Location" }, "Name", "silly-rabbit-test-a1b2c3d4");
    expect(result.Name).toBe("silly-rabbit-test-a1b2c3d4 Test Location");
  });

  it("leaves other fields untouched", () => {
    const result = injectMarker({ Name: "Test", Region: "West" }, "Name", "silly-rabbit-test-a1b2c3d4");
    expect(result.Region).toBe("West");
  });

  it("handles an empty existing value", () => {
    const result = injectMarker({ Name: "" }, "Name", "silly-rabbit-test-a1b2c3d4");
    expect(result.Name).toBe("silly-rabbit-test-a1b2c3d4");
  });
});
