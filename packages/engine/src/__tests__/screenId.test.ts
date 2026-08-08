import { describe, expect, it } from "vitest";
import { deriveScreenId } from "../screenId.js";

const BASE = "https://dev.rabbit.example/fleet/auth/platform/locations";

describe("deriveScreenId — Algorithm A golden fixtures (engine-spec §6)", () => {
  it("collapses locale variants of the same screen to the same screenId", () => {
    const en = deriveScreenId({ url: BASE, ariaSnapshot: '- heading "Locations" [level=1]' });
    const de = deriveScreenId({ url: BASE, ariaSnapshot: '- heading "Standorte" [level=1]' });
    expect(en.screenId).toBe(de.screenId);
    expect(en.headingAnchor).toBe("Locations");
    expect(de.headingAnchor).toBe("Standorte");
  });

  it("collapses id-path variants (different ids, same resource) to the same screenId", () => {
    const a = deriveScreenId({ url: `${BASE}/48213`, ariaSnapshot: "" });
    const b = deriveScreenId({ url: `${BASE}/77`, ariaSnapshot: "" });
    expect(a.screenId).toBe(b.screenId);
    expect(a.normalizedUrl).toBe("https://dev.rabbit.example/fleet/auth/platform/locations/:id");
  });

  it("collapses query-string variants (default: query dropped) to the same screenId", () => {
    const a = deriveScreenId({ url: `${BASE}?page=2`, ariaSnapshot: "" });
    const b = deriveScreenId({ url: `${BASE}?page=3&sort=name`, ariaSnapshot: "" });
    expect(a.screenId).toBe(b.screenId);
  });

  it("does not collapse genuinely different screens", () => {
    const locations = deriveScreenId({ url: BASE, ariaSnapshot: "" });
    const vehicles = deriveScreenId({
      url: "https://dev.rabbit.example/fleet/auth/platform/vehicles",
      ariaSnapshot: "",
    });
    expect(locations.screenId).not.toBe(vehicles.screenId);
  });

  it("does not collapse a list screen with its own detail screen", () => {
    const list = deriveScreenId({ url: BASE, ariaSnapshot: "" });
    const detail = deriveScreenId({ url: `${BASE}/48213`, ariaSnapshot: "" });
    expect(list.screenId).not.toBe(detail.screenId);
  });

  it("gives distinct hash routes on one path distinct screenIds (hash-router SPAs)", () => {
    const locations = deriveScreenId({ url: "https://dev.rabbit.example/#/locations", ariaSnapshot: "" });
    const settings = deriveScreenId({ url: "https://dev.rabbit.example/#/settings", ariaSnapshot: "" });
    expect(locations.screenId).not.toBe(settings.screenId);
    expect(locations.normalizedUrl).toBe("https://dev.rabbit.example#/locations");
    expect(settings.normalizedUrl).toBe("https://dev.rabbit.example#/settings");
  });

  it("collapses trailing ids inside a route fragment, same as path ids", () => {
    const a = deriveScreenId({ url: "https://dev.rabbit.example/#/locations/48213", ariaSnapshot: "" });
    const b = deriveScreenId({ url: "https://dev.rabbit.example/#/locations/77", ariaSnapshot: "" });
    expect(a.screenId).toBe(b.screenId);
    expect(a.normalizedUrl).toBe("https://dev.rabbit.example#/locations/:id");
  });

  it("handles hashbang (#!/) route fragments", () => {
    const a = deriveScreenId({ url: "https://dev.rabbit.example/#!/locations", ariaSnapshot: "" });
    const b = deriveScreenId({ url: "https://dev.rabbit.example/#!/vehicles", ariaSnapshot: "" });
    expect(a.screenId).not.toBe(b.screenId);
    expect(a.normalizedUrl).toBe("https://dev.rabbit.example#!/locations");
  });

  it("still strips plain in-page anchors — a scroll target is not a screen", () => {
    const anchored = deriveScreenId({ url: `${BASE}#section-2`, ariaSnapshot: "" });
    const plain = deriveScreenId({ url: BASE, ariaSnapshot: "" });
    expect(anchored.screenId).toBe(plain.screenId);
  });

  it("drops query strings inside a route fragment (same policy as the URL's own query)", () => {
    const a = deriveScreenId({ url: "https://dev.rabbit.example/#/locations?page=2", ariaSnapshot: "" });
    const b = deriveScreenId({ url: "https://dev.rabbit.example/#/locations?page=3&sort=name", ariaSnapshot: "" });
    expect(a.screenId).toBe(b.screenId);
    expect(a.normalizedUrl).toBe("https://dev.rabbit.example#/locations");
  });

  it("falls back h1 -> h2 -> documentTitle for headingAnchor, never into the id hash", () => {
    const h2Only = deriveScreenId({
      url: BASE,
      ariaSnapshot: '- heading "Section" [level=2]',
      documentTitle: "rabbit",
    });
    expect(h2Only.headingAnchor).toBe("Section");

    const titleOnly = deriveScreenId({ url: BASE, ariaSnapshot: "", documentTitle: "rabbit" });
    expect(titleOnly.headingAnchor).toBe("rabbit");
    expect(h2Only.screenId).toBe(titleOnly.screenId);
  });
});
