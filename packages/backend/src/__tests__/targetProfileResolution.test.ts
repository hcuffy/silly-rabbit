import { ActiveTargetProfileSchema, type TargetProfile } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { ActiveTargetProfileRepo } from "../repos/activeTargetProfileRepo.js";
import { TargetProfileRepo } from "../repos/targetProfileRepo.js";
import {
  resolveActiveProfileForRequest,
  resolveActiveProfileOverrides,
  withActiveProfileOverrides,
} from "../targetProfileResolution.js";

const CREDENTIAL_ENCRYPTION_KEY = "b".repeat(64);

function makeProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    id: randomUUID(),
    name: "Release",
    baseUrl: "https://release.example.com",
    loginUrl: "https://release.example.com/#/login",
    email: "test@example.com",
    password: "hunter2",
    emailSelector: "[data-cy-id=\"login.email\"]",
    passwordSelector: "[data-cy-id=\"login.password\"]",
    submitSelector: "[data-cy-id=\"login.button\"]",
    locationsPath: "/fleet/auth/platform/locations",
    allowedDomains: ["release.example.com"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveActiveProfileOverrides / withActiveProfileOverrides (target-profiles-spec.md §4, backward-compat step)", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;
  let targetProfileRepo: TargetProfileRepo;
  let activeTargetProfileRepo: ActiveTargetProfileRepo;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    targetProfileRepo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    activeTargetProfileRepo = new ActiveTargetProfileRepo(connection.db);
  });

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("zero profiles / no active pointer: resolves to an empty override — the byte-identical fallback state", async () => {
    const overrides = await resolveActiveProfileOverrides(activeTargetProfileRepo, targetProfileRepo);
    expect(overrides).toEqual({});
  });

  it("withActiveProfileOverrides is a true no-op when no active profile exists — env-sourced deps " +
    "fields (loginCreds, allowedDomains, productionUrlPatterns) all pass through completely untouched", async () => {
    const bootDeps = {
      activeTargetProfileRepo,
      targetProfileRepo,
      loginCreds: { loginUrl: "https://env.example.com/login", email: "env@example.com", password: "env-pass",
        emailSelector: "#e", passwordSelector: "#p", submitSelector: "#s" },
      allowedDomains: ["env.example.com"],
      productionUrlPatterns: [/prod\.example\.com/],
    };

    const effectiveDeps = await withActiveProfileOverrides(bootDeps);

    expect(effectiveDeps.loginCreds).toEqual(bootDeps.loginCreds);
    expect(effectiveDeps.allowedDomains).toEqual(bootDeps.allowedDomains);
    expect(effectiveDeps.productionUrlPatterns).toBe(bootDeps.productionUrlPatterns);
  });

  it("withActiveProfileOverrides no-ops when the repos aren't present on deps at all — the shape every " +
    "pre-existing test's hand-built deps object has, proving those tests need no changes", async () => {
    const bootDeps: {
      allowedDomains: string[];
      targetProfileRepo?: TargetProfileRepo;
      activeTargetProfileRepo?: ActiveTargetProfileRepo;
    } = { allowedDomains: ["env.example.com"] };
    expect(await withActiveProfileOverrides(bootDeps)).toBe(bootDeps);
  });

  it("an active, fully-configured profile overrides loginCreds/allowedDomains/charterNav.locationsPath — " +
    "PROD_URL_PATTERNS-equivalent (productionUrlPatterns) is never touched, confirmed by its absence here", async () => {
    const profile = makeProfile({ id: randomUUID() });
    await targetProfileRepo.create(profile);
    await activeTargetProfileRepo.set(profile.id);

    const bootDeps = {
      activeTargetProfileRepo,
      targetProfileRepo,
      loginCreds: { loginUrl: "https://env.example.com/login", email: "env@example.com", password: "env-pass",
        emailSelector: "#e", passwordSelector: "#p", submitSelector: "#s" },
      allowedDomains: ["env.example.com"],
      productionUrlPatterns: [/prod\.example\.com/],
    };

    const effectiveDeps = await withActiveProfileOverrides(bootDeps);

    expect(effectiveDeps.loginCreds).toEqual({
      loginUrl: profile.loginUrl,
      email: profile.email,
      password: profile.password,
      emailSelector: profile.emailSelector,
      passwordSelector: profile.passwordSelector,
      submitSelector: profile.submitSelector,
      nextSelector: undefined,
      timeoutMs: undefined,
      loginReadyTimeoutMs: undefined,
    });
    expect(effectiveDeps.allowedDomains).toEqual(profile.allowedDomains);
    expect(effectiveDeps.charterNav).toEqual({ locationsPath: profile.locationsPath });
    expect(effectiveDeps.productionUrlPatterns).toBe(bootDeps.productionUrlPatterns);

    await activeTargetProfileRepo.clear();
    await targetProfileRepo.delete(profile.id);
  });

  it("an active profile with incomplete login config (no password) explicitly overrides loginCreds to " +
    "undefined — replacing env's login entirely, not merging with it", async () => {
    const profile = makeProfile({ id: randomUUID(), password: undefined });
    await targetProfileRepo.create(profile);
    await activeTargetProfileRepo.set(profile.id);

    const bootDeps = {
      activeTargetProfileRepo,
      targetProfileRepo,
      loginCreds: { loginUrl: "https://env.example.com/login", email: "env@example.com", password: "env-pass",
        emailSelector: "#e", passwordSelector: "#p", submitSelector: "#s" },
      allowedDomains: ["env.example.com"],
    };

    const effectiveDeps = await withActiveProfileOverrides(bootDeps);

    expect(effectiveDeps.loginCreds).toBeUndefined();
    expect(effectiveDeps.allowedDomains).toEqual(profile.allowedDomains);

    await activeTargetProfileRepo.clear();
    await targetProfileRepo.delete(profile.id);
  });
});

describe("resolveActiveProfileForRequest — closes the double-round-trip active-profile race " +
  "(app.ts POST /runs, POST /explorer/runs, navMapRoutes.ts POST /nav-map/crawl used to each do two " +
  "independent fetches, one for baseUrl and one for overrides)", () => {
  it("fetches the active profile exactly once — targetBaseUrl and the rest of the overrides always come " +
    "from the same read, even when a second read would return a different profile", async () => {
    const profileA = makeProfile({ id: randomUUID(), name: "A", baseUrl: "https://a.example.com", allowedDomains: ["a.example.com"] });
    const profileB = makeProfile({ id: randomUUID(), name: "B", baseUrl: "https://b.example.com", allowedDomains: ["b.example.com"] });

    const activePointerGet = vi.fn(() =>
      Promise.resolve(ActiveTargetProfileSchema.parse({ profileId: profileA.id, updatedAt: new Date() })),
    );
    const profileGet = vi.fn().mockResolvedValueOnce(profileA).mockResolvedValueOnce(profileB);

    const stubActiveTargetProfileRepo = { get: activePointerGet } as unknown as ActiveTargetProfileRepo;
    const stubTargetProfileRepo = { get: profileGet } as unknown as TargetProfileRepo;

    const { activeProfileBaseUrl, deps } = await resolveActiveProfileForRequest({
      activeTargetProfileRepo: stubActiveTargetProfileRepo,
      targetProfileRepo: stubTargetProfileRepo,
    });

    expect(profileGet).toHaveBeenCalledTimes(1);
    expect(activeProfileBaseUrl).toBe(profileA.baseUrl);
    expect(deps.allowedDomains).toEqual(profileA.allowedDomains);
  });
});
