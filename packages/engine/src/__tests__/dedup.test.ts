import { describe, expect, it } from "vitest";
import { computeDedupKey } from "../dedup.js";
import { maskErrorMessage } from "../mask.js";
import { normalizeUrl } from "../screenId.js";
import type { FindingDraft } from "../types.js";

describe("computeDedupKey — dedup golden fixtures (engine-spec §6, §5 C.1)", () => {
  it("treats two console errors differing only in stack line:col as the same issue", () => {
    const a: FindingDraft = {
      screenId: "screen-1",
      type: "CONSOLE_ERROR",
      evidence: {},
      maskedSignature: maskErrorMessage("TypeError: x is undefined at app.js:42:7"),
    };
    const b: FindingDraft = {
      screenId: "screen-1",
      type: "CONSOLE_ERROR",
      evidence: {},
      maskedSignature: maskErrorMessage("TypeError: x is undefined at app.js:108:3"),
    };
    expect(computeDedupKey(a)).toBe(computeDedupKey(b));
  });

  it("treats two HTTP errors with the same method/url/status-class as the same issue", () => {
    const url = normalizeUrl("https://dev.rabbit.example/fleet/auth/platform/locations/48213");
    const a: FindingDraft = {
      screenId: "screen-1",
      type: "HTTP_ERROR",
      evidence: {},
      maskedSignature: `GET ${url} 4xx`,
    };
    const b: FindingDraft = {
      screenId: "screen-1",
      type: "HTTP_ERROR",
      evidence: {},
      maskedSignature: `GET ${url} 4xx`,
    };
    expect(computeDedupKey(a)).toBe(computeDedupKey(b));
  });

  it("treats genuinely different errors as different issues", () => {
    const a: FindingDraft = {
      screenId: "screen-1",
      type: "CONSOLE_ERROR",
      evidence: {},
      maskedSignature: maskErrorMessage("TypeError: x is undefined"),
    };
    const b: FindingDraft = {
      screenId: "screen-1",
      type: "CONSOLE_ERROR",
      evidence: {},
      maskedSignature: maskErrorMessage("ReferenceError: y is not defined"),
    };
    expect(computeDedupKey(a)).not.toBe(computeDedupKey(b));
  });

  it("treats the same error message on a different screen as a different issue", () => {
    const message = maskErrorMessage("TypeError: x is undefined");
    const a: FindingDraft = { screenId: "screen-1", type: "CONSOLE_ERROR", evidence: {}, maskedSignature: message };
    const b: FindingDraft = { screenId: "screen-2", type: "CONSOLE_ERROR", evidence: {}, maskedSignature: message };
    expect(computeDedupKey(a)).not.toBe(computeDedupKey(b));
  });
});
