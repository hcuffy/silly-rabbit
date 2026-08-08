import { describe, expect, it } from "vitest";
import { AppMapSchema } from "../appMap.js";

describe("AppMapSchema", () => {
  it("parses a valid app map", () => {
    const result = AppMapSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      baseUrl: "https://dev.rabbit.example",
      screens: [
        {
          screenId: "screen-1",
          normalizedUrl: "/bookings",
          headingAnchor: "Bookings",
          discoveredAt: new Date(),
        },
      ],
    });
    expect(result.screens).toHaveLength(1);
  });

  it("rejects an invalid app map", () => {
    expect(() =>
      AppMapSchema.parse({
        id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        baseUrl: "not-a-url",
        screens: [],
      }),
    ).toThrow();
  });
});
