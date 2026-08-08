import { parseAriaSnapshot } from "@silly-rabbit/engine";
import { describe, expect, it } from "vitest";
import { detectCardGroup, detectTable } from "../researchTable.js";

describe("detectTable (explorer-spec §6 step 2 — table branch)", () => {
  it("finds a table role and extracts header columnheader names as entityFields", () => {
    const tree = parseAriaSnapshot(`
- table "Locations"
  - rowgroup
    - row
      - columnheader "Name"
      - columnheader "City"
  - rowgroup
    - row
      - cell "Main Warehouse"
      - cell "Berlin"
`);
    const result = detectTable(tree);
    expect(result?.element).toMatchObject({ kind: "table", role: "table" });
    expect(result?.entityFields).toEqual(["Name", "City"]);
  });

  it("returns undefined when no table role or repeated rows exist", () => {
    const tree = parseAriaSnapshot(`- button "Save"`);
    expect(detectTable(tree)).toBeUndefined();
  });
});

describe("detectCardGroup (explorer-spec §6 step 2 — card branch, no table role)", () => {
  it("finds a repeated sibling group and derives entityFields from the first card's labeled sub-nodes", () => {
    const tree = parseAriaSnapshot(`
- list
  - listitem
    - heading "Card One"
    - text "Detail A"
  - listitem
    - heading "Card Two"
    - text "Detail B"
`);
    const result = detectCardGroup(tree);
    expect(result?.element.kind).toBe("card");
    expect(result?.entityFields).toEqual(["Card One", "Detail A"]);
  });

  it("returns undefined when no repeated sibling group exists", () => {
    const tree = parseAriaSnapshot(`- button "Save"`);
    expect(detectCardGroup(tree)).toBeUndefined();
  });
});
