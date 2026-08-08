import { maskText } from "@silly-rabbit/engine";
import type { ResearchInventory } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { buildDedupSignature, computeCheckDedupKey } from "../dedupSignature.js";

function makeResearch(overrides: Partial<ResearchInventory> = {}): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [],
    entityFields: [],
    ariaSnapshotMasked: "- heading",
    capturedAt: new Date(),
    ...overrides,
  };
}

describe("buildDedupSignature (fixes a real dedup collision — see below for proof it existed)", () => {
  it("preserves the description verbatim when no category is given", () => {
    expect(buildDedupSignature("Submit a valid location")).toBe("Submit a valid location");
  });

  it("two different descriptions produce two different signatures", () => {
    const first = buildDedupSignature("Submit a valid location");
    const second = buildDedupSignature("Click the export button");
    expect(first).not.toBe(second);
  });

  it("incorporates category when given, so same description + different category differ", () => {
    const longString = buildDedupSignature("Submit with a bad value", "long_string");
    const emptyRequired = buildDedupSignature("Submit with a bad value", "empty_required");
    expect(longString).not.toBe(emptyRequired);
  });

  it("same description + same category (or no category) produce the same signature — dedup still works", () => {
    expect(buildDedupSignature("Submit a valid location")).toBe(buildDedupSignature("Submit a valid location"));
    expect(buildDedupSignature("Submit with a bad value", "long_string")).toBe(
      buildDedupSignature("Submit with a bad value", "long_string"),
    );
  });

  it("PROOF the collision this replaces was real: maskText collapses any two plain-English " +
    "descriptions to the identical literal token '<TEXT>', which is why routing check descriptions " +
    "through it (the pre-fix approach) silently merged unrelated checks' findings", () => {
    const first = maskText("Submit a valid location");
    const second = maskText("Click the export button");
    const third = maskText("Submit with a bad value long_string");
    const fourth = maskText("Submit with a bad value empty_required");

    expect(first).toBe("<TEXT>");
    expect(second).toBe("<TEXT>");
    expect(third).toBe("<TEXT>");
    expect(fourth).toBe("<TEXT>");
    expect(first).toBe(second);
    expect(third).toBe(fourth);

    expect(buildDedupSignature("Submit a valid location")).not.toBe(buildDedupSignature("Click the export button"));
    expect(buildDedupSignature("Submit with a bad value", "long_string")).not.toBe(
      buildDedupSignature("Submit with a bad value", "empty_required"),
    );
  });
});

describe("computeCheckDedupKey (explorer-spec §10.4 — pure function, no Finding object required to exist)", () => {
  it("is deterministic: same research + description + category always produces the same key", () => {
    const research = makeResearch();
    const first = computeCheckDedupKey(research, "Submit with a bad value", "long_string");
    const second = computeCheckDedupKey(research, "Submit with a bad value", "long_string");
    expect(first).toBe(second);
  });

  it("different descriptions on the same screen produce different keys", () => {
    const research = makeResearch();
    const first = computeCheckDedupKey(research, "Submit a valid location");
    const second = computeCheckDedupKey(research, "Click the export button");
    expect(first).not.toBe(second);
  });

  it("different categories on the same description produce different keys", () => {
    const research = makeResearch();
    const first = computeCheckDedupKey(research, "Submit with a bad value", "long_string");
    const second = computeCheckDedupKey(research, "Submit with a bad value", "empty_required");
    expect(first).not.toBe(second);
  });

  it("the same check on a different screen (different sectionUrl) produces a different key", () => {
    const first = computeCheckDedupKey(makeResearch({ sectionUrl: "https://dev.rabbit.example/fleet/locations" }), "Submit");
    const second = computeCheckDedupKey(makeResearch({ sectionUrl: "https://dev.rabbit.example/fleet/vehicles" }), "Submit");
    expect(first).not.toBe(second);
  });
});
