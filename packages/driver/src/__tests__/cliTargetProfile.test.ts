import { encryptCredential } from "@silly-rabbit/shared/node";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../cli.js";
import { closeMongo, connectMongo, type RunStoreConnection } from "../runStore.js";

const CREDENTIAL_ENCRYPTION_KEY = "f".repeat(64);

interface TargetProfileFixtureDocument {
  _id: string;
  name: string;
  baseUrl: string;
  loginUrl?: string;
  email?: string;
  password?: string;
  emailSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  allowedDomains: string[];
  createdAt: Date;
  updatedAt: Date;
}

function targetProfilesCollection(connection: RunStoreConnection) {
  return connection.db.collection<TargetProfileFixtureDocument>("targetProfiles");
}

describe("cli main() --profile flag (target-profiles-spec.md phase 3, item 2)", () => {
  let mongod: MongoMemoryServer;
  let connection: RunStoreConnection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    process.env.MONGO_URI = mongod.getUri();
    process.env.CREDENTIAL_ENCRYPTION_KEY = CREDENTIAL_ENCRYPTION_KEY;
  });

  afterAll(async () => {
    delete process.env.MONGO_URI;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    await closeMongo(connection);
    await mongod.stop();
  });

  afterEach(() => {
    delete process.env.ALLOWED_DOMAINS;
  });

  async function runArguments(profileFlag: string): Promise<string[]> {
    const stateDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-profile-state-"));
    const outputDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-profile-out-"));
    return [
      "--charter", "test the locations flow",
      "--run", randomUUID(),
      "--state", join(stateDirectory, "driver-state.json"),
      "--out", outputDirectory,
      "--profile", profileFlag,
    ];
  }

  it("--profile resolves by name and its baseUrl takes effect — a real run genuinely completes " +
    "against that distinct, non-default baseUrl (mock-target route interception is broad enough " +
    "to service any hostname, so this proves application, not just a write-then-crash)", async () => {
    const profileId = randomUUID();
    await targetProfilesCollection(connection).insertOne({
      _id: profileId,
      name: "Profile Fixture By Name",
      baseUrl: "http://profile-fixture-by-name.invalid",
      allowedDomains: ["profile-fixture-by-name.invalid"],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await main(await runArguments("Profile Fixture By Name"));

    const documents = await connection.db.collection("runs").find().toArray();
    const written = documents[documents.length - 1];
    expect(written?.targetBaseUrl).toBe("http://profile-fixture-by-name.invalid");
    expect(written?.status).toBe("COMPLETED");
  }, 20_000);

  it("--profile also resolves by literal id, not just name", async () => {
    const profileId = randomUUID();
    await targetProfilesCollection(connection).insertOne({
      _id: profileId,
      name: "Profile Fixture By Id",
      baseUrl: "http://profile-fixture-by-id.invalid",
      allowedDomains: ["profile-fixture-by-id.invalid"],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await main(await runArguments(profileId));

    const documents = await connection.db.collection("runs").find().toArray();
    const written = documents[documents.length - 1];
    expect(written?.targetBaseUrl).toBe("http://profile-fixture-by-id.invalid");
    expect(written?.status).toBe("COMPLETED");
  }, 20_000);

  it("an unresolvable --profile name/id throws a clear error before touching Mongo run-storage or " +
    "a browser", async () => {
    const before = await connection.db.collection("runs").countDocuments();

    await expect(main(await runArguments("does-not-exist"))).rejects.toThrow(/target profile not found/);

    expect(await connection.db.collection("runs").countDocuments()).toBe(before);
  });

  it("the profile's OWN allowedDomains governs the safety check, not env's ALLOWED_DOMAINS — proven " +
    "by making env's list permissive and the profile's list restrictive for the same host", async () => {
    process.env.ALLOWED_DOMAINS = "not-allowed.example.com";

    const profileId = randomUUID();
    await targetProfilesCollection(connection).insertOne({
      _id: profileId,
      name: "Locked-down profile",
      baseUrl: "https://not-allowed.example.com",
      loginUrl: "https://not-allowed.example.com/login",
      email: encryptCredential("test@example.com", CREDENTIAL_ENCRYPTION_KEY),
      password: encryptCredential("hunter2", CREDENTIAL_ENCRYPTION_KEY),
      emailSelector: "#email",
      passwordSelector: "#password",
      submitSelector: "#submit",
      allowedDomains: ["completely-different-domain.example.com"],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(main(await runArguments("Locked-down profile"))).rejects.toThrow(/not on the domain allowlist/);
  });

  it("omitting --profile entirely is completely unaffected by any of this — the zero-config demo path", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-noprofile-state-"));
    const outputDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-noprofile-out-"));

    const documents = await main([
      "--charter", "test the locations flow",
      "--run", randomUUID(),
      "--state", join(stateDirectory, "driver-state.json"),
      "--out", outputDirectory,
    ]).then(() => connection.db.collection("runs").find().toArray());

    const written = documents[documents.length - 1];
    expect(written?.targetBaseUrl).toBe("http://mock.local");
    expect(written?.status).toBe("COMPLETED");
  });
});
