import { describe, expect, it } from "vitest";
import { maskErrorMessage, maskText } from "../mask.js";

describe("maskText — masking golden fixtures (engine-spec §6, §4 B.1/B.2)", () => {
  it("masks a pure ISO-8601 timestamp to <TIME>", () => {
    expect(maskText("2024-06-21T10:00:00Z")).toBe("<TIME>");
  });

  it("masks English relative time inline, preserving generic text as <TEXT>", () => {
    expect(maskText("Updated 2 hours ago")).toBe("<TIME> <TEXT>");
  });

  it("masks a pure UUID to <ID>", () => {
    expect(maskText("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d")).toBe("<ID>");
  });

  it("preserves numbers while masking surrounding localized words (§7.4)", () => {
    expect(maskText("5 vehicles")).toBe("5 <TEXT>");
    expect(maskText("5 Fahrzeuge")).toBe("5 <TEXT>");
  });

  it("normalizes thousands-grouping so en and de formatting compare equal", () => {
    expect(maskText("1,000 vehicles")).toBe("1000 <TEXT>");
    expect(maskText("1.000 Fahrzeuge")).toBe("1000 <TEXT>");
  });

  it("collapses plain localized text (no numbers/ids/timestamps) to <TEXT>", () => {
    expect(maskText("Booking overview")).toBe("<TEXT>");
    expect(maskText("Buchungsübersicht")).toBe("<TEXT>");
  });

  it("masks German relative time inline ('vor'), same as the English 'ago' form (validation #3 fix)", () => {
    expect(maskText("Vor 3 Stunden aktualisiert")).toBe("<TIME> <TEXT>");
    expect(maskText("vor 1 Minute")).toBe("<TIME>");
    expect(maskText("vor 45 Sekunden")).toBe("<TIME>");
    expect(maskText("vor 2 Tagen")).toBe("<TIME>");
    expect(maskText("vor 3 Wochen")).toBe("<TIME>");
    expect(maskText("vor 6 Monaten")).toBe("<TIME>");
    expect(maskText("vor 1 Jahr")).toBe("<TIME>");
  });

  it("masks German relative time inline ('in X Y'), same word order as English", () => {
    expect(maskText("in 5 Minuten")).toBe("<TIME>");
  });

  it("masks the German 'just now' equivalent", () => {
    expect(maskText("gerade eben")).toBe("<TIME>");
  });

  it(
    "masks a bare HH:MM clock time (colon or space separated) without catching ID-shaped digit " +
      "groups nearby (validation #3 fix — real target evidence showed '08 35' surviving unmasked " +
      "next to real ID-like values such as '333 47')",
    () => {
      expect(maskText("08:35")).toBe("<TIME>");
      expect(maskText("08 35")).toBe("<TIME>");
      expect(maskText("Geändert am 08 35")).toBe("<TIME> <TEXT>");
      expect(maskText("333 47")).toBe("333 47");
      expect(maskText("112 47")).toBe("112 47");
      expect(maskText("22 83")).toBe("22 83");
      expect(maskText("51642")).toBe("51642");
    },
  );

  it("masks the exact real row shape from the repro spec — clock time masked, IDs and counts preserved", () => {
    expect(maskText("333 47 51642 4 08 35")).toBe("<TIME> 333 47 51642 4");
  });

  it(
    "masks clock time glued directly to a trailing locale word, no separator (real target evidence: " +
      "German 'Uhr' suffix glued with no space broke the trailing \\b boundary, leaking '08 35' " +
      "unmasked next to real ID-like values)",
    () => {
      expect(maskText("25.07.2026 08:35Uhr")).toBe("<TIME> <TIME> <TEXT>");
      expect(maskText("25.07.2026 08:35Uhr brian91896")).toBe("<TIME> <TIME> 91896 <TEXT>");
    },
  );
});

describe("maskErrorMessage — dedup-signature masking (engine-spec §5 C.1)", () => {
  it("masks stack line:col and other numbers, unlike maskText", () => {
    const a = maskErrorMessage("TypeError: x is undefined at app.js:42:7");
    const b = maskErrorMessage("TypeError: x is undefined at app.js:108:3");
    expect(a).toBe(b);
    expect(a).toBe("TypeError: x is undefined at app.js:<LINE>:<COL>");
  });
});
