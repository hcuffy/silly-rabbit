import { describe, expect, it } from "vitest";
import { formatDateTime, formatTime } from "../formatDateTime.js";

describe("formatDateTime", () => {
  it("formats a date as absolute local YYYY-MM-DD HH:MM:SS", () => {
    const date = new Date(2026, 6, 25, 15, 40, 4);
    expect(formatDateTime(date)).toBe("2026-07-25 15:40:04");
  });

  it("pads single-digit month, day, hour, minute, second", () => {
    const date = new Date(2026, 0, 5, 3, 5, 9);
    expect(formatDateTime(date)).toBe("2026-01-05 03:05:09");
  });
});

describe("formatTime", () => {
  it("formats a date as local HH:MM", () => {
    expect(formatTime(new Date(2026, 6, 25, 15, 40, 4))).toBe("15:40");
  });

  it("pads single-digit hour and minute", () => {
    expect(formatTime(new Date(2026, 0, 5, 3, 5, 9))).toBe("03:05");
  });
});
