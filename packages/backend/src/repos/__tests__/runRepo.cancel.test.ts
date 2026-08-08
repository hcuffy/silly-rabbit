import type { Run } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { RunRepo } from "../runRepo.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: randomUUID(),
    charter: "test the locations flow",
    targetBaseUrl: "http://mock.local",
    status: "PENDING",
    startedAt: new Date(),
    stepsUsed: 0,
    llmCallsUsed: 0,
    costUsd: 0,
    ...overrides,
  };
}

describe("RunRepo — cancel/delete (delete-cancel-spec.md, phase 1)", () => {
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

  it("cancel() flips PENDING to CANCELLED and returns true", async () => {
    const repo = new RunRepo(connection.db);
    const run = makeRun({ status: "PENDING" });
    await repo.create(run);

    const result = await repo.cancel(run.id);
    expect(result).toBe(true);

    const fetched = await repo.get(run.id);
    expect(fetched?.status).toBe("CANCELLED");
    expect(fetched?.finishedAt).toBeInstanceOf(Date);
  });

  it("cancel() flips RUNNING to CANCELLED and returns true", async () => {
    const repo = new RunRepo(connection.db);
    const run = makeRun({ status: "RUNNING" });
    await repo.create(run);

    expect(await repo.cancel(run.id)).toBe(true);
    expect((await repo.get(run.id))?.status).toBe("CANCELLED");
  });

  it("cancel() is a no-op and returns false for an already-COMPLETED run — never overwrites a real terminal status", async () => {
    const repo = new RunRepo(connection.db);
    const run = makeRun({ status: "COMPLETED", finishedAt: new Date("2020-01-01") });
    await repo.create(run);

    const result = await repo.cancel(run.id);
    expect(result).toBe(false);

    const fetched = await repo.get(run.id);
    expect(fetched?.status).toBe("COMPLETED");
    expect(fetched?.finishedAt).toEqual(new Date("2020-01-01"));
  });

  it("cancel() is a no-op and returns false for an already-FAILED run", async () => {
    const repo = new RunRepo(connection.db);
    const run = makeRun({ status: "FAILED", error: "boom" });
    await repo.create(run);

    expect(await repo.cancel(run.id)).toBe(false);
    expect((await repo.get(run.id))?.status).toBe("FAILED");
  });

  it("cancel() returns false for an unknown id", async () => {
    const repo = new RunRepo(connection.db);
    expect(await repo.cancel(randomUUID())).toBe(false);
  });

  it("delete() removes the run entirely — a subsequent get() returns null", async () => {
    const repo = new RunRepo(connection.db);
    const run = makeRun();
    await repo.create(run);
    expect(await repo.get(run.id)).not.toBeNull();

    await repo.delete(run.id);
    expect(await repo.get(run.id)).toBeNull();
  });

  it("delete() on an unknown id does not throw", async () => {
    const repo = new RunRepo(connection.db);
    await expect(repo.delete(randomUUID())).resolves.toBeUndefined();
  });
});
