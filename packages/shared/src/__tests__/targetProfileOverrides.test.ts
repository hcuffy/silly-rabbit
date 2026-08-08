import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTargetProfileOverrides } from "../targetProfileOverrides.js";
import type { TargetProfile } from "../schemas/targetProfile.js";

function makeProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    id: randomUUID(),
    name: "Release",
    baseUrl: "https://release.example.com",
    allowedDomains: ["release.example.com"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("buildTargetProfileOverrides (shared, pure — reused by dashboard/CLI/MCP resolution paths)", () => {
  it("carries baseUrl, allowedDomains, and charterNav.locationsPath through unchanged", () => {
    const profile = makeProfile({ locationsPath: "/fleet/auth/platform/locations" });

    const overrides = buildTargetProfileOverrides(profile);

    expect(overrides.baseUrl).toBe(profile.baseUrl);
    expect(overrides.allowedDomains).toEqual(profile.allowedDomains);
    expect(overrides.charterNav).toEqual({ locationsPath: "/fleet/auth/platform/locations" });
  });

  it("builds loginCreds when every required login field is present", () => {
    const profile = makeProfile({
      loginUrl: "https://release.example.com/login",
      email: "test@example.com",
      password: "hunter2",
      emailSelector: "#email",
      passwordSelector: "#password",
      submitSelector: "#submit",
      nextSelector: "#next",
      timeoutMs: 5000,
    });

    const overrides = buildTargetProfileOverrides(profile);

    expect(overrides.loginCreds).toEqual({
      loginUrl: profile.loginUrl,
      email: profile.email,
      password: profile.password,
      emailSelector: profile.emailSelector,
      passwordSelector: profile.passwordSelector,
      submitSelector: profile.submitSelector,
      nextSelector: "#next",
      timeoutMs: 5000,
      loginReadyTimeoutMs: undefined,
    });
  });

  it("loginCreds is undefined when any required login field is missing (no login for this profile)", () => {
    const profile = makeProfile({
      loginUrl: "https://release.example.com/login",
      email: "test@example.com",
      emailSelector: "#email",
      passwordSelector: "#password",
      submitSelector: "#submit",
    });

    expect(buildTargetProfileOverrides(profile).loginCreds).toBeUndefined();
  });

  it("a profile with no login fields at all (baseUrl/allowedDomains only) still produces valid overrides", () => {
    const overrides = buildTargetProfileOverrides(makeProfile());

    expect(overrides.loginCreds).toBeUndefined();
    expect(overrides.baseUrl).toBeTruthy();
    expect(overrides.allowedDomains.length).toBeGreaterThan(0);
  });
});
