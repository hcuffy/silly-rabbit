import { describe, expect, it, vi } from "vitest";
import { findEmptyRequiredFields, focusFirstInvalidField } from "../requiredFieldValidation.js";

describe("findEmptyRequiredFields", () => {
  it("returns the keys of fields whose value is empty or whitespace-only", () => {
    const empty = findEmptyRequiredFields([
      { key: "name", id: "name", value: "" },
      { key: "url", id: "url", value: "   " },
      { key: "kind", id: "kind", value: "release" },
    ]);

    expect(empty).toEqual(new Set(["name", "url"]));
  });

  it("returns an empty set when every field has a real value", () => {
    const empty = findEmptyRequiredFields([{ key: "name", id: "name", value: "Dev" }]);

    expect(empty.size).toBe(0);
  });
});

describe("focusFirstInvalidField", () => {
  it("focuses the DOM element for the first field (in list order) that's in the invalid set", () => {
    document.body.innerHTML = '<input id="name" /><input id="url" />';
    const nameInput = document.getElementById("name") as HTMLInputElement;
    const urlInput = document.getElementById("url") as HTMLInputElement;
    const focusName = vi.spyOn(nameInput, "focus");
    const focusUrl = vi.spyOn(urlInput, "focus");

    focusFirstInvalidField(
      [
        { key: "name", id: "name", value: "" },
        { key: "url", id: "url", value: "" },
      ],
      new Set(["url", "name"]),
    );

    expect(focusName).toHaveBeenCalled();
    expect(focusUrl).not.toHaveBeenCalled();
  });

  it("does nothing when the invalid set is empty", () => {
    document.body.innerHTML = '<input id="name" />';
    const nameInput = document.getElementById("name") as HTMLInputElement;
    const focusName = vi.spyOn(nameInput, "focus");

    focusFirstInvalidField([{ key: "name", id: "name", value: "" }], new Set());

    expect(focusName).not.toHaveBeenCalled();
  });
});
