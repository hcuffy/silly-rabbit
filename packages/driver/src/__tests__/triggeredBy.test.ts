import { describe, expect, it } from "vitest";
import { getTriggeredBy } from "../triggeredBy.js";

describe("getTriggeredBy", () => {
  it("returns the username from the injected user-info source", () => {
    expect(getTriggeredBy(() => ({ username: "henry" }))).toBe("henry");
  });

  it("defaults to the real OS user when no source is injected", () => {
    expect(getTriggeredBy()).toEqual(expect.any(String));
    expect(getTriggeredBy().length).toBeGreaterThan(0);
  });
});
