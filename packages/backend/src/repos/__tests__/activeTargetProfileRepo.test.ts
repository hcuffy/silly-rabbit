import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { ActiveTargetProfileRepo } from "../activeTargetProfileRepo.js";

describe("ActiveTargetProfileRepo (single-document pointer, not an isActive boolean field) — mongodb-memory-server", () => {
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

  it("get returns null when no active profile has ever been set — the zero-profiles / fresh-install state", async () => {
    const repo = new ActiveTargetProfileRepo(connection.db);
    expect(await repo.get()).toBeNull();
  });

  it("set then get round-trips the pointer", async () => {
    const repo = new ActiveTargetProfileRepo(connection.db);
    const profileId = randomUUID();

    await repo.set(profileId);
    const pointer = await repo.get();

    expect(pointer?.profileId).toBe(profileId);
    expect(pointer?.updatedAt).toBeInstanceOf(Date);
  });

  it(
    "setting a second time replaces the pointer rather than creating a second document — exactly " +
      "one active profile holds by construction, not by an enforced invariant",
    async () => {
      const repo = new ActiveTargetProfileRepo(connection.db);
      const first = randomUUID();
      const second = randomUUID();

      await repo.set(first);
      await repo.set(second);

      expect((await repo.get())?.profileId).toBe(second);
      expect(await connection.db.collection("activeTargetProfile").countDocuments()).toBe(1);
    },
  );

  it("clear removes the pointer, returning to the no-active-profile state", async () => {
    const repo = new ActiveTargetProfileRepo(connection.db);
    await repo.set(randomUUID());

    await repo.clear();

    expect(await repo.get()).toBeNull();
  });
});
