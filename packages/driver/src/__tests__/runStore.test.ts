import type { Run } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, RunStore, type RunStoreConnection } from "../runStore.js";

interface RunDocument {
  _id: string;
  charter: string;
  status: string;
  stepsUsed: number;
  error?: string;
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    charter: "test the locations flow",
    targetBaseUrl: "http://mock.local",
    status: "RUNNING",
    startedAt: new Date(),
    stepsUsed: 0,
    llmCallsUsed: 0,
    costUsd: 0,
    ...overrides,
  };
}

describe("RunStore (CLI Run persistence, Pass 1 option B) — mongodb-memory-server, no Docker", () => {
  let mongod: MongoMemoryServer;
  let connection: RunStoreConnection;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    connection = await connectMongo(mongod.getUri());
  });

  afterAll(async () => {
    await closeMongo(connection);
    await mongod.stop();
  });

  it("writes to the same 'runs' collection the backend's RunRepo reads from", async () => {
    const store = new RunStore(connection.db);
    const run = makeRun();
    await store.create(run);

    const document = await connection.db.collection<RunDocument>("runs").findOne({ _id: run.id });
    expect(document).not.toBeNull();
    expect(document?.charter).toBe(run.charter);
    expect(document?.status).toBe("RUNNING");
  });

  it("updateStatus patches only the given fields, matching backend RunRepo's patch shape", async () => {
    const store = new RunStore(connection.db);
    const run = makeRun();
    await store.create(run);

    const finishedAt = new Date();
    await store.updateStatus(run.id, { status: "COMPLETED", finishedAt, stepsUsed: 4, llmCallsUsed: 2, costUsd: 0.1 });

    const document = await connection.db.collection<RunDocument>("runs").findOne({ _id: run.id });
    expect(document?.status).toBe("COMPLETED");
    expect(document?.stepsUsed).toBe(4);
    expect(document?.charter).toBe(run.charter);
  });

  it("records a FAILED status with an error message", async () => {
    const store = new RunStore(connection.db);
    const run = makeRun();
    await store.create(run);

    await store.updateStatus(run.id, { status: "FAILED", finishedAt: new Date(), error: "login failed" });

    const document = await connection.db.collection<RunDocument>("runs").findOne({ _id: run.id });
    expect(document?.status).toBe("FAILED");
    expect(document?.error).toBe("login failed");
  });
});
