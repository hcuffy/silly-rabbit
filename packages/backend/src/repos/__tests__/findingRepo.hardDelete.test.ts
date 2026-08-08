import type { Finding } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { FindingRepo } from "../findingRepo.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    runId: "run-1",
    screenId: "screen-1",
    type: "CONSOLE_ERROR",
    evidence: {},
    dedupKey: `dedup-${randomUUID()}`,
    status: "NEW",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("FindingRepo — hardDelete (delete-cancel-spec.md, phase 1) — distinct from the existing DISMISSED soft-status path", () => {
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

  it("hardDelete() removes the finding entirely — a subsequent get() returns null", async () => {
    const repo = new FindingRepo(connection.db);
    const finding = makeFinding();
    await repo.upsert(finding);
    expect(await repo.get(finding.id)).not.toBeNull();

    await repo.hardDelete(finding.id);
    expect(await repo.get(finding.id)).toBeNull();
  });

  it("a DISMISSED finding still exists (queryable, appears in listByRun) until hardDelete is called " +
    "separately — dismiss and hard-delete are two distinct mechanisms, not one", async () => {
    const repo = new FindingRepo(connection.db);
    const finding = makeFinding({ status: "DISMISSED", runId: `run-${randomUUID()}` });
    await repo.upsert(finding);

    const beforeDelete = await repo.get(finding.id);
    expect(beforeDelete?.status).toBe("DISMISSED");
    expect(await repo.listByRun(finding.runId)).toHaveLength(1);

    await repo.hardDelete(finding.id);
    expect(await repo.get(finding.id)).toBeNull();
    expect(await repo.listByRun(finding.runId)).toHaveLength(0);
  });

  it("deleteByRunIds() bulk-removes every finding for the given run ids, leaves others untouched", async () => {
    const repo = new FindingRepo(connection.db);
    const runIdToDelete = `run-${randomUUID()}`;
    const otherRunId = `run-${randomUUID()}`;
    const target = makeFinding({ runId: runIdToDelete });
    const other = makeFinding({ runId: otherRunId });
    await repo.upsert(target);
    await repo.upsert(other);

    await repo.deleteByRunIds([runIdToDelete]);

    expect(await repo.get(target.id)).toBeNull();
    expect(await repo.get(other.id)).not.toBeNull();
  });

  it("deleteByRunIds() with an empty array is a no-op, does not throw", async () => {
    const repo = new FindingRepo(connection.db);
    await expect(repo.deleteByRunIds([])).resolves.toBeUndefined();
  });
});
