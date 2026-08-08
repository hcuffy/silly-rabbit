import type { NavMap } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { NavMapRepo } from "../navMapRepo.js";

function makeNavMap(overrides: Partial<NavMap> = {}): NavMap {
  return {
    id: randomUUID(),
    baseUrl: "https://target-a.example.com",
    entries: [
      { role: "link", label: "Home", discoveredAt: new Date(), isStale: false },
    ],
    crawledAt: new Date(),
    crawlDurationMs: 1234,
    ...overrides,
  };
}

describe("NavMapRepo (app-mapping-spec.md §4) — mongodb-memory-server, no Docker", () => {
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

  it("round-trips a crawled NavMap by baseUrl", async () => {
    const repo = new NavMapRepo(connection.db);
    const navMap = makeNavMap();

    await repo.upsert(navMap);
    const retrieved = await repo.getByBaseUrl(navMap.baseUrl);

    expect(retrieved).toEqual(navMap);
  });

  it("getByBaseUrl for an unknown baseUrl returns null, not some other target's map", async () => {
    const repo = new NavMapRepo(connection.db);
    await repo.upsert(makeNavMap({ id: randomUUID(), baseUrl: "https://target-b.example.com" }));

    expect(await repo.getByBaseUrl("https://never-crawled.example.com")).toBeNull();
  });

  it("re-crawling the same baseUrl overwrites its NavMap in place rather than creating a second document", async () => {
    const repo = new NavMapRepo(connection.db);
    const baseUrl = "https://target-c.example.com";
    const first = makeNavMap({ id: randomUUID(), baseUrl, entries: [{ role: "link", label: "V1", discoveredAt: new Date(), isStale: false }] });
    await repo.upsert(first);

    const second = makeNavMap({ id: first.id, baseUrl, entries: [{ role: "link", label: "V2", discoveredAt: new Date(), isStale: false }] });
    await repo.upsert(second);

    const retrieved = await repo.getByBaseUrl(baseUrl);
    expect(retrieved?.entries.map((entry) => entry.label)).toEqual(["V2"]);

    const rawCount = await connection.db.collection("navMaps").countDocuments({ baseUrl });
    expect(rawCount).toBe(1);
  });

  it("two different baseUrls produce two fully separate NavMap documents — no cross-target contamination " +
    "(the exact AppMapRepo mistake this repo must not repeat: AppMapRepo.get() does a bare findOne({}) " +
    "with no baseUrl filter, returning one global document regardless of target)", async () => {
    const repo = new NavMapRepo(connection.db);
    const navMapA = makeNavMap({
      id: randomUUID(),
      baseUrl: "https://isolation-a.example.com",
      entries: [{ role: "link", label: "Only in A", discoveredAt: new Date(), isStale: false }],
    });
    const navMapB = makeNavMap({
      id: randomUUID(),
      baseUrl: "https://isolation-b.example.com",
      entries: [{ role: "link", label: "Only in B", discoveredAt: new Date(), isStale: false }],
    });

    await repo.upsert(navMapA);
    await repo.upsert(navMapB);

    const retrievedA = await repo.getByBaseUrl(navMapA.baseUrl);
    const retrievedB = await repo.getByBaseUrl(navMapB.baseUrl);

    expect(retrievedA?.entries.map((entry) => entry.label)).toEqual(["Only in A"]);
    expect(retrievedB?.entries.map((entry) => entry.label)).toEqual(["Only in B"]);
    expect(retrievedA?.id).not.toBe(retrievedB?.id);
  });

  it("delete removes only the targeted baseUrl's NavMap", async () => {
    const repo = new NavMapRepo(connection.db);
    const kept = makeNavMap({ id: randomUUID(), baseUrl: "https://keep.example.com" });
    const removed = makeNavMap({ id: randomUUID(), baseUrl: "https://remove.example.com" });
    await repo.upsert(kept);
    await repo.upsert(removed);

    await repo.delete(removed.baseUrl);

    expect(await repo.getByBaseUrl(removed.baseUrl)).toBeNull();
    expect(await repo.getByBaseUrl(kept.baseUrl)).not.toBeNull();
  });

  it("ensureIndexes creates a unique baseUrl index, and is idempotent", async () => {
    const repo = new NavMapRepo(connection.db);
    await repo.ensureIndexes();
    await repo.ensureIndexes();

    const indexes = await connection.db.collection("navMaps").indexes();
    const baseUrlIndex = indexes.find((index) => index.key.baseUrl === 1);
    expect(baseUrlIndex).toBeDefined();
    expect(baseUrlIndex?.unique).toBe(true);
  });

  it("the unique baseUrl index actually rejects a second document for the same baseUrl inserted directly " +
    "(not just relying on the repo's own replaceOne-by-id logic to prevent duplicates)", async () => {
    const repo = new NavMapRepo(connection.db);
    await repo.ensureIndexes();
    const baseUrl = "https://duplicate-guard.example.com";
    await repo.upsert(makeNavMap({ id: randomUUID(), baseUrl }));

    await expect(
      connection.db
        .collection<{ _id: string; baseUrl: string; entries: unknown[]; crawledAt: Date; crawlDurationMs: number }>("navMaps")
        .insertOne({ _id: randomUUID(), baseUrl, entries: [], crawledAt: new Date(), crawlDurationMs: 0 }),
    ).rejects.toThrow();
  });
});
