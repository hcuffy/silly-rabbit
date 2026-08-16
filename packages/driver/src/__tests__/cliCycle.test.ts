import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../cli.js";
import { closeMongo, connectMongo, type RunStoreConnection } from "../runStore.js";

interface CycleFixtureDocument {
  _id: string;
  name: string;
  kind: "sprint" | "release";
  status: "active" | "archived";
  isDefault: boolean;
  runCounter: number;
  sessionReplayRunCounter: number;
  createdAt: Date;
}

function cyclesCollection(connection: RunStoreConnection) {
  return connection.db.collection<CycleFixtureDocument>("cycles");
}

async function insertCycle(connection: RunStoreConnection, overrides: Partial<Omit<CycleFixtureDocument, "_id">> = {}): Promise<string> {
  const id = randomUUID();
  await cyclesCollection(connection).insertOne({
    _id: id,
    name: "Sprint 42",
    kind: "sprint",
    status: "active",
    isDefault: false,
    runCounter: 0,
    sessionReplayRunCounter: 0,
    createdAt: new Date(),
    ...overrides,
  });
  return id;
}

describe("cli main() --cycle flag (run-cycles-spec.md phase 3)", () => {
  let mongod: MongoMemoryServer;
  let connection: RunStoreConnection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
    process.env.MONGO_URI = mongod.getUri();
  });

  afterAll(async () => {
    delete process.env.MONGO_URI;
    await closeMongo(connection);
    await mongod.stop();
  });

  async function runArguments(extra: string[]): Promise<string[]> {
    const stateDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-cycle-state-"));
    const outputDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-cli-cycle-out-"));
    return [
      "--charter",
      "test the locations flow",
      "--run",
      randomUUID(),
      "--state",
      join(stateDirectory, "driver-state.json"),
      "--out",
      outputDirectory,
      ...extra,
    ];
  }

  it("--cycle resolves by name and stamps a real cycleRunNumber onto the persisted Run", async () => {
    const cycleId = await insertCycle(connection, { name: "Sprint By Name" });

    await main(await runArguments(["--cycle", "Sprint By Name"]));

    const documents = await connection.db.collection("runs").find().toArray();
    const written = documents[documents.length - 1];
    expect(written?.cycleId).toBe(cycleId);
    expect(written?.cycleRunNumber).toBe(1);
    expect(written?.status).toBe("COMPLETED");
  }, 20_000);

  it("--cycle also resolves by literal id, and increments across repeated runs (2nd run gets number 2)", async () => {
    const cycleId = await insertCycle(connection, { name: "Sprint By Id" });

    await main(await runArguments(["--cycle", cycleId]));
    await main(await runArguments(["--cycle", cycleId]));

    const documents = await connection.db.collection("runs").find({ cycleId }).sort({ startedAt: 1 }).toArray();
    expect(documents).toHaveLength(2);
    expect(documents[0]?.cycleRunNumber).toBe(1);
    expect(documents[1]?.cycleRunNumber).toBe(2);
  }, 30_000);

  it("an unresolvable --cycle name/id throws a clear error before touching run-storage", async () => {
    const before = await connection.db.collection("runs").countDocuments();

    await expect(main(await runArguments(["--cycle", "does-not-exist"]))).rejects.toThrow(/cycle not found/);

    expect(await connection.db.collection("runs").countDocuments()).toBe(before);
  });

  it("omitting --cycle entirely is completely unaffected — zero-config path stays uncycled, exactly as before", async () => {
    await main(await runArguments([]));

    const documents = await connection.db.collection("runs").find().toArray();
    const written = documents[documents.length - 1];
    expect(written?.cycleId).toBeUndefined();
    expect(written?.cycleRunNumber).toBeUndefined();
    expect(written?.status).toBe("COMPLETED");
  }, 20_000);

  it("--profile and --cycle together apply independently in one invocation — disjoint field sets, no conflict", async () => {
    const profileId = randomUUID();
    await connection.db
      .collection<{
        _id: string;
        name: string;
        baseUrl: string;
        allowedDomains: string[];
        createdAt: Date;
        updatedAt: Date;
      }>("targetProfiles")
      .insertOne({
        _id: profileId,
        name: "Combined Profile",
        baseUrl: "http://combined-profile.invalid",
        allowedDomains: ["combined-profile.invalid"],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    const cycleId = await insertCycle(connection, { name: "Combined Cycle" });

    await main(await runArguments(["--profile", "Combined Profile", "--cycle", "Combined Cycle"]));

    const documents = await connection.db.collection("runs").find().toArray();
    const written = documents[documents.length - 1];
    expect(written?.targetBaseUrl).toBe("http://combined-profile.invalid");
    expect(written?.cycleId).toBe(cycleId);
    expect(written?.cycleRunNumber).toBe(1);
    expect(written?.status).toBe("COMPLETED");
  }, 20_000);
});
