import { describe, expect, it } from "vitest";
import { parseAriaSnapshot } from "../ariaTree.js";

describe("parseAriaSnapshot — leaf-text formats (found via real-target validation, all three now handled)", () => {
  it("format A (already working): role \"name\" [attrs] on one line", () => {
    const tree = parseAriaSnapshot('- textbox "Search" [required]');
    expect(tree.children[0]).toMatchObject({ role: "textbox", name: "Search", attrs: { required: true } });
  });

  it("format B (was silently dropped): role [attrs]: \"quoted text\"", () => {
    const tree = parseAriaSnapshot('- paragraph [box=8,66,1264,18]: "Showing 10 of 42 results"');
    expect(tree.children[0]).toMatchObject({ role: "paragraph", name: "Showing 10 of 42 results" });
  });

  it("format C (was silently dropped): role: unquoted text, no attrs", () => {
    const tree = parseAriaSnapshot("- text: Displaying");
    expect(tree.children[0]).toMatchObject({ role: "text", name: "Displaying" });
  });

  it("format C content containing embedded literal quote marks is preserved verbatim", () => {
    const tree = parseAriaSnapshot('- text: Click the button "Continue" to proceed.');
    expect(tree.children[0]?.name).toBe('Click the button "Continue" to proceed.');
  });

  it("a parent-with-children line ending in a bare colon, no inline content, still leaves name undefined (no regression)", () => {
    const tree = parseAriaSnapshot('- cell [box=1,2,3,4]:\n  - button "Open"');
    const cell = tree.children[0];
    expect(cell).toMatchObject({ role: "cell", name: undefined });
    expect(cell?.children).toHaveLength(1);
    expect(cell?.children[0]).toMatchObject({ role: "button", name: "Open" });
  });

  it("a parent-with-children line that also has a quoted name still parses the name (no regression)", () => {
    const tree = parseAriaSnapshot('- columnheader "Updated" [box=1,2,3,4]:\n  - button "Sort"');
    const header = tree.children[0];
    expect(header).toMatchObject({ role: "columnheader", name: "Updated" });
    expect(header?.children).toHaveLength(1);
  });
});
