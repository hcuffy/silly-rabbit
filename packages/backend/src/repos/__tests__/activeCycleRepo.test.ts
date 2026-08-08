import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { ActiveCycleRepo } from "../activeCycleRepo.js";

describe("ActiveCycleRepo (single-document pointer, not an isActive boolean field) — mongodb-memory-server", () => {
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

  it("get returns null when no active cycle has ever been set — the zero-cycles / fresh-install state", async () => {
    const repo = new ActiveCycleRepo(connection.db);
    expect(await repo.get()).toBeNull();
  });

  it("set then get round-trips the pointer", async () => {
    const repo = new ActiveCycleRepo(connection.db);
    const cycleId = randomUUID();

    await repo.set(cycleId);
    const pointer = await repo.get();

    expect(pointer?.cycleId).toBe(cycleId);
    expect(pointer?.updatedAt).toBeInstanceOf(Date);
  });

  it("setting a second time replaces the pointer rather than creating a second document — exactly " +
    "one active cycle holds by construction, not by an enforced invariant", async () => {
    const repo = new ActiveCycleRepo(connection.db);
    const first = randomUUID();
    const second = randomUUID();

    await repo.set(first);
    await repo.set(second);

    expect((await repo.get())?.cycleId).toBe(second);
    expect(await connection.db.collection("activeCycle").countDocuments()).toBe(1);
  });

  it("clear removes the pointer, returning to the no-active-cycle state", async () => {
    const repo = new ActiveCycleRepo(connection.db);
    await repo.set(randomUUID());

    await repo.clear();

    expect(await repo.get()).toBeNull();
  });
});
