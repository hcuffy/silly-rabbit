import { parseAriaSnapshot } from "@silly-rabbit/engine";
import type { SectionElement } from "@silly-rabbit/shared";
import { describe, expect, it } from "vitest";
import { walkInteractiveNodes } from "../researchClassify.js";

function classify(snapshot: string): SectionElement[] {
  const tree = parseAriaSnapshot(snapshot);
  const out: SectionElement[] = [];
  walkInteractiveNodes(tree, new Set(), out);
  return out;
}

describe("walkInteractiveNodes — element-kind classification (explorer-spec §6 step 2)", () => {
  it("classifies a textbox as input", () => {
    const [element] = classify(`- textbox "Search"`);
    expect(element).toMatchObject({ kind: "input", accessibleName: "Search", role: "textbox" });
  });

  it("classifies a combobox with enumerable options as dropdown", () => {
    const [element] = classify(`
- combobox "Status"
  - option "Active"
  - option "Inactive"
`);
    expect(element).toMatchObject({ kind: "dropdown", accessibleName: "Status", options: ["Active", "Inactive"] });
  });

  it("classifies a combobox with no exposed options as dropdown, options omitted", () => {
    const [element] = classify(`- combobox "Status"`);
    expect(element).toMatchObject({ kind: "dropdown", accessibleName: "Status" });
    expect(element?.options).toBeUndefined();
  });

  it("classifies a textbox whose name matches the date regex family as dateFilter (§13.2)", () => {
    const [element] = classify(`- textbox "25.07.2026"`);
    expect(element).toMatchObject({ kind: "dateFilter", accessibleName: "25.07.2026", role: "textbox" });
  });

  it("a plain English date-word label with no digits falls through to input, not dateFilter (documented gap, §6 locale note)", () => {
    const [element] = classify(`- textbox "Start Date"`);
    expect(element).toMatchObject({ kind: "input", accessibleName: "Start Date" });
  });

  it("classifies a button as button", () => {
    const [element] = classify(`- button "Save"`);
    expect(element).toMatchObject({ kind: "button", accessibleName: "Save" });
  });

  it("classifies a checkbox as other", () => {
    const [element] = classify(`- checkbox "Enable notifications"`);
    expect(element).toMatchObject({ kind: "other", accessibleName: "Enable notifications" });
  });

  it("detects required via an exposed [required] attribute", () => {
    const [element] = classify(`- textbox "Name" [required]`);
    expect(element?.required).toBe(true);
  });

  it("detects required via a trailing asterisk in the accessible name (best-effort fallback)", () => {
    const [element] = classify(`- textbox "Name *"`);
    expect(element?.required).toBe(true);
  });

  it("required is omitted, not false, when neither signal is present", () => {
    const [element] = classify(`- textbox "Name"`);
    expect(element?.required).toBeUndefined();
  });

  it("a non-interactive role (heading/text) produces no element", () => {
    const out = classify(`- heading "Locations" [level=1]`);
    expect(out).toHaveLength(0);
  });
});
