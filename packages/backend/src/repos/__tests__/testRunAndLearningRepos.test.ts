import type { Learning, ResearchInventory, TestRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { LearningRepo } from "../learningRepo.js";
import { TestRunRepo } from "../testRunRepo.js";

function makeResearch(overrides: Partial<ResearchInventory> = {}): ResearchInventory {
  return {
    featureId: "locations",
    sectionUrl: "https://dev.rabbit.example/fleet/locations",
    sectionHeading: "Locations",
    detectedLanguage: "en",
    elements: [],
    entityFields: [],
    ariaSnapshotMasked: "- heading",
    capturedAt: new Date(),
    ...overrides,
  };
}

function makeTestRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: randomUUID(),
    featureId: "locations",
    runId: "run-1",
    research: makeResearch(),
    testPlan: [],
    checkOutcomes: [],
    findingIds: [],
    startedAt: new Date(),
    finishedAt: new Date(),
    status: "COMPLETED",
    ...overrides,
  };
}

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  const now = new Date();
  return {
    id: randomUUID(),
    featureId: "locations",
    learningType: "confirmed_issue",
    description: "the name field silently accepts an empty value",
    source: "run_verdict",
    firstSeenRunId: "run-1",
    lastConfirmedRunId: "run-1",
    status: "active",
    dedupKey: "dedup-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("TestRunRepo / LearningRepo (explorer-spec §10.1) — mongodb-memory-server, no Docker", () => {
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

  describe("TestRunRepo", () => {
    it("round-trips a created TestRun, validated against TestRunSchema", async () => {
      const repo = new TestRunRepo(connection.db);
      const testRun = makeTestRun();
      await repo.create(testRun);
      expect(await repo.get(testRun.id)).toEqual(testRun);
    });

    it("get returns null for an unknown id", async () => {
      const repo = new TestRunRepo(connection.db);
      expect(await repo.get(randomUUID())).toBeNull();
    });

    it("update patches only the given fields, survives a re-read (D8 live-incident resilience fix — " +
      "incremental persistence)", async () => {
      const repo = new TestRunRepo(connection.db);
      const testRun = makeTestRun({ status: "RUNNING" });
      await repo.create(testRun);

      const finishedAt = new Date();
      await repo.update(testRun.id, {
        status: "COMPLETED",
        finishedAt,
        checkOutcomes: [{ hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", check: "happy", result: "timed_out" }],
      });

      const fetched = await repo.get(testRun.id);
      expect(fetched?.status).toBe("COMPLETED");
      expect(fetched?.finishedAt).toEqual(finishedAt);
      expect(fetched?.checkOutcomes).toEqual([
        { hypothesisId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", check: "happy", result: "timed_out" },
      ]);
      expect(fetched?.featureId).toBe(testRun.featureId);
    });

    it("findLatestByFeatureId returns the most recently started TestRun for that featureId only (feature-docs-spec §1)", async () => {
      const repo = new TestRunRepo(connection.db);
      const featureId = `feature-${randomUUID()}`;
      const older = makeTestRun({ featureId, startedAt: new Date(Date.now() - 60_000) });
      const newer = makeTestRun({ featureId, startedAt: new Date() });
      const otherFeature = makeTestRun({ featureId: "other-feature", startedAt: new Date() });
      await repo.create(older);
      await repo.create(newer);
      await repo.create(otherFeature);

      const latest = await repo.findLatestByFeatureId(featureId);
      expect(latest?.id).toBe(newer.id);
    });

    it("findLatestByFeatureId returns null when no TestRun exists for that featureId", async () => {
      const repo = new TestRunRepo(connection.db);
      expect(await repo.findLatestByFeatureId(`feature-${randomUUID()}`)).toBeNull();
    });

    it("list paginates most-recent-first and reports total, mirroring RunRepo.list()", async () => {
      const repo = new TestRunRepo(connection.db);
      const featureId = `feature-${randomUUID()}`;
      const older = makeTestRun({ featureId, startedAt: new Date("2020-01-01T00:00:00Z") });
      const newer = makeTestRun({ featureId, startedAt: new Date("2020-01-02T00:00:00Z") });
      await repo.create(older);
      await repo.create(newer);

      const fullList = await repo.list({ limit: 1000, offset: 0 });
      const ids = fullList.testRuns.map((testRun) => testRun.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      expect(fullList.total).toBeGreaterThanOrEqual(2);

      const onePage = await repo.list({ limit: 1, offset: 0 });
      expect(onePage.testRuns).toHaveLength(1);
    });

    it("ensureIndexes creates a featureId+startedAt compound index, and is idempotent", async () => {
      const repo = new TestRunRepo(connection.db);
      await repo.ensureIndexes();
      await repo.ensureIndexes();

      const indexes = await connection.db.collection("testRuns").indexes();
      expect(indexes.some((index) => index.key.featureId === 1 && index.key.startedAt === -1)).toBe(true);
    });

    it("cancel() flips RUNNING to CANCELLED and returns true; is a no-op returning false once " +
      "COMPLETED (delete-cancel-spec.md, phase 1)", async () => {
      const repo = new TestRunRepo(connection.db);
      const running = makeTestRun({ status: "RUNNING" });
      await repo.create(running);
      expect(await repo.cancel(running.id)).toBe(true);
      expect((await repo.get(running.id))?.status).toBe("CANCELLED");

      const completed = makeTestRun({ status: "COMPLETED" });
      await repo.create(completed);
      expect(await repo.cancel(completed.id)).toBe(false);
      expect((await repo.get(completed.id))?.status).toBe("COMPLETED");
    });

    it("delete() removes the TestRun entirely", async () => {
      const repo = new TestRunRepo(connection.db);
      const testRun = makeTestRun();
      await repo.create(testRun);
      await repo.delete(testRun.id);
      expect(await repo.get(testRun.id)).toBeNull();
    });
  });

  describe("LearningRepo", () => {
    it("round-trips an upserted learning", async () => {
      const repo = new LearningRepo(connection.db);
      const learning = makeLearning({ dedupKey: "dedup-roundtrip" });
      await repo.upsert(learning);
      expect(await repo.findByDedupKey(learning.featureId, "dedup-roundtrip")).toEqual(learning);
    });

    it("upsert replaces the existing learning (by id) rather than duplicating", async () => {
      const repo = new LearningRepo(connection.db);
      const learning = makeLearning({ dedupKey: "dedup-replace" });
      await repo.upsert(learning);
      await repo.upsert({ ...learning, status: "resolved", updatedAt: new Date() });

      const fetched = await repo.findByDedupKey(learning.featureId, "dedup-replace");
      expect(fetched?.status).toBe("resolved");
    });

    it("findActiveByFeatureId scopes to featureId + status:'active' (§10.3's query shape)", async () => {
      const repo = new LearningRepo(connection.db);
      const featureId = `feature-${randomUUID()}`;
      const active = makeLearning({ featureId, dedupKey: "active-1", status: "active" });
      const resolved = makeLearning({ featureId, dedupKey: "resolved-1", status: "resolved" });
      const otherFeature = makeLearning({ featureId: "other-feature", dedupKey: "other-1", status: "active" });
      await repo.upsert(active);
      await repo.upsert(resolved);
      await repo.upsert(otherFeature);

      const results = await repo.findActiveByFeatureId(featureId);
      expect(results.map((learning) => learning.id)).toEqual([active.id]);
    });

    it("findByDedupKey returns null when no match", async () => {
      const repo = new LearningRepo(connection.db);
      expect(await repo.findByDedupKey("locations", "no-such-dedup-key")).toBeNull();
    });

    it("ensureIndexes creates a featureId+status compound index matching findActiveByFeatureId's query shape, " +
      "and is idempotent", async () => {
      const repo = new LearningRepo(connection.db);
      await repo.ensureIndexes();
      await repo.ensureIndexes();

      const indexes = await connection.db.collection("learnings").indexes();
      expect(indexes.some((index) => index.key.featureId === 1 && index.key.status === 1)).toBe(true);
    });
  });
});
