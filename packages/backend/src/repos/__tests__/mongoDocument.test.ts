import { describe, expect, it } from "vitest";
import { stripUndefinedKeys } from "../mongoDocument.js";

describe("stripUndefinedKeys (dormant undefined-to-null-on-read bug, closed repo-wide)", () => {
  it("removes keys whose value is undefined, keeps everything else including falsy values", () => {
    const result = stripUndefinedKeys({ a: 1, b: undefined, c: 0, d: "", e: null, f: "x" });
    expect(result).toEqual({ a: 1, c: 0, d: "", e: null, f: "x" });
    expect("b" in result).toBe(false);
  });

  it("is a no-op when nothing is undefined", () => {
    const input = { a: 1, b: "x" };
    expect(stripUndefinedKeys(input)).toEqual(input);
  });
});
