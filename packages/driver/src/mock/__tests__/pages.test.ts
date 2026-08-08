import { describe, expect, it } from "vitest";
import { renderLocationDetailHtml, renderLocationsListHtml, type MockSeed } from "../pages.js";

const baselineSeed: MockSeed = {
  recordId: "11111111-1111-1111-1111-111111111111",
  timestamp: "2026-01-01T00:00:00Z",
  count: 3,
};
const volatileSeed: MockSeed = {
  recordId: "22222222-2222-2222-2222-222222222222",
  timestamp: "2026-06-22T10:00:00Z",
  count: 3,
};

describe("renderLocationsListHtml (driver-spec §2)", () => {
  it("baseline vs volatile-only differ only in volatile fields, not structure", () => {
    const baseline = renderLocationsListHtml("baseline", baselineSeed);
    const volatile = renderLocationsListHtml("volatile-only", volatileSeed);

    expect(baseline).toContain("<h1>Locations</h1>");
    expect(volatile).toContain("<h1>Locations</h1>");
    expect(baseline).toContain("Add Location");
    expect(volatile).toContain("Add Location");
    expect(baseline).not.toBe(volatile);
  });

  it("changed-regression omits the Add Location button (the planted structural divergence)", () => {
    const html = renderLocationsListHtml("changed-regression", baselineSeed);
    expect(html).not.toContain("Add Location");
    expect(html).toContain("<h1>Locations</h1>");
  });
});

describe("renderLocationDetailHtml", () => {
  it("renders the seeded record id and timestamp", () => {
    const html = renderLocationDetailHtml(baselineSeed);
    expect(html).toContain(baselineSeed.recordId);
    expect(html).toContain(baselineSeed.timestamp);
  });
});
