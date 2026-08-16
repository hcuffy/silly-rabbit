import { describe, expect, it } from "vitest";
import { computeRunNumber } from "../runNumbering.js";

describe(
  "computeRunNumber (single source of truth — RunHistory's # column and RunDetail's header " + "both reuse this, not two separate implementations)",
  () => {
    it("computes a 1-based, offset-aware global position", () => {
      expect(computeRunNumber(0, 0)).toBe(1);
      expect(computeRunNumber(0, 24)).toBe(25);
      expect(computeRunNumber(25, 0)).toBe(26);
      expect(computeRunNumber(50, 3)).toBe(54);
    });
  },
);
