import type { TargetProfile } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { TargetProfileRepo } from "../targetProfileRepo.js";

const CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);

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
    allowedDomains: ["release.example.com"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("TargetProfileRepo (target-profiles-spec.md §3) — mongodb-memory-server, no Docker", () => {
  let mongod: MongoMemoryServer;
  let connection: MongoConnection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
  });

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("round-trips a created profile, including its encrypted email/password fields, decrypted back correctly", async () => {
    const repo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    const profile = makeProfile();

    await repo.create(profile);
    const retrieved = await repo.get(profile.id);

    expect(retrieved).toEqual(profile);
  });

  it("the raw Mongo document stores email/password as ciphertext, never plaintext — real assertion " +
    "against the stored document itself, not just the repo's decrypted return value", async () => {
    const repo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    const profile = makeProfile({ id: randomUUID(), email: "raw-check@example.com", password: "super-secret-value" });

    await repo.create(profile);

    const rawDocument = await connection.db
      .collection<{ _id: string; email: string; password: string }>("targetProfiles")
      .findOne({ _id: profile.id });
    expect(rawDocument).not.toBeNull();
    expect(rawDocument?.email).not.toBe("raw-check@example.com");
    expect(rawDocument?.email).not.toContain("raw-check@example.com");
    expect(rawDocument?.password).not.toBe("super-secret-value");
    expect(rawDocument?.password).not.toContain("super-secret-value");
    expect(rawDocument?.email.split(":")).toHaveLength(3);
    expect(rawDocument?.password.split(":")).toHaveLength(3);
  });

  it("a profile with no login configured (selectors/credentials all omitted) round-trips fine — " +
    "profiles are allowed to carry just baseUrl/allowedDomains", async () => {
    const repo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    const profile = makeProfile({
      id: randomUUID(),
      loginUrl: undefined,
      email: undefined,
      password: undefined,
      emailSelector: undefined,
      passwordSelector: undefined,
      submitSelector: undefined,
    });

    await repo.create(profile);
    expect(await repo.get(profile.id)).toEqual(profile);
  });

  it("list returns all profiles, sorted by name", async () => {
    const repo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    const zebra = makeProfile({ id: randomUUID(), name: `Zebra-${randomUUID()}` });
    const alpha = makeProfile({ id: randomUUID(), name: `Alpha-${randomUUID()}` });
    await repo.create(zebra);
    await repo.create(alpha);

    const names = (await repo.list()).map((profile) => profile.name);
    expect(names.indexOf(alpha.name)).toBeLessThan(names.indexOf(zebra.name));
  });

  it("update re-encrypts a changed password and leaves other fields untouched", async () => {
    const repo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    const profile = makeProfile({ id: randomUUID() });
    await repo.create(profile);

    await repo.update(profile.id, { password: "new-password" });

    const updated = await repo.get(profile.id);
    expect(updated?.password).toBe("new-password");
    expect(updated?.email).toBe(profile.email);
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(profile.updatedAt.getTime());
  });

  it("delete removes the profile", async () => {
    const repo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    const profile = makeProfile({ id: randomUUID() });
    await repo.create(profile);

    await repo.delete(profile.id);
    expect(await repo.get(profile.id)).toBeNull();
  });

  it("ensureIndexes creates a name index, and is idempotent", async () => {
    const repo = new TargetProfileRepo(connection.db, CREDENTIAL_ENCRYPTION_KEY);
    await repo.ensureIndexes();
    await repo.ensureIndexes();

    const indexes = await connection.db.collection("targetProfiles").indexes();
    expect(indexes.some((index) => index.key.name === 1)).toBe(true);
  });
});
