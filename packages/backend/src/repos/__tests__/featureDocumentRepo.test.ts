import type { FeatureDocument } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { FeatureDocumentRepo } from "../featureDocumentRepo.js";

function makeFeatureDocument(overrides: Partial<FeatureDocument> = {}): FeatureDocument {
  return {
    id: randomUUID(),
    featureId: "locations",
    generatedAt: new Date(),
    sourceTestRunId: randomUUID(),
    activeLearningIds: [],
    content: "# Locations\n\nThis feature lists locations.",
    model: "claude-sonnet-4-6",
    llmCallsUsed: 1,
    costUsd: 0.01,
    ...overrides,
  };
}

describe("FeatureDocumentRepo (feature-docs-spec §1/§2) — mongodb-memory-server, no Docker", () => {
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

  it("round-trips a created feature doc, validated against FeatureDocumentSchema", async () => {
    const repo = new FeatureDocumentRepo(connection.db);
    const featureDocument = makeFeatureDocument();
    await repo.create(featureDocument);
    expect(await repo.findLatestByFeatureId(featureDocument.featureId)).toEqual(featureDocument);
  });

  it("create is append-only — a second generation for the same featureId does not overwrite the first", async () => {
    const repo = new FeatureDocumentRepo(connection.db);
    const featureId = `feature-${randomUUID()}`;
    const first = makeFeatureDocument({ featureId, generatedAt: new Date(Date.now() - 60_000) });
    const second = makeFeatureDocument({ featureId, generatedAt: new Date() });
    await repo.create(first);
    await repo.create(second);

    const history = await repo.findByFeatureId(featureId);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("findByFeatureId returns newest-first", async () => {
    const repo = new FeatureDocumentRepo(connection.db);
    const featureId = `feature-${randomUUID()}`;
    const older = makeFeatureDocument({ featureId, generatedAt: new Date(Date.now() - 60_000) });
    const newer = makeFeatureDocument({ featureId, generatedAt: new Date() });
    await repo.create(older);
    await repo.create(newer);

    const history = await repo.findByFeatureId(featureId);
    expect(history.map((entry) => entry.id)).toEqual([newer.id, older.id]);
  });

  it("findLatestByFeatureId returns only the newest generation, scoped to that featureId", async () => {
    const repo = new FeatureDocumentRepo(connection.db);
    const featureId = `feature-${randomUUID()}`;
    const older = makeFeatureDocument({ featureId, generatedAt: new Date(Date.now() - 60_000) });
    const newer = makeFeatureDocument({ featureId, generatedAt: new Date() });
    const otherFeature = makeFeatureDocument({ featureId: "other-feature", generatedAt: new Date() });
    await repo.create(older);
    await repo.create(newer);
    await repo.create(otherFeature);

    const latest = await repo.findLatestByFeatureId(featureId);
    expect(latest?.id).toBe(newer.id);
  });

  it("findLatestByFeatureId returns null when no doc exists for that featureId", async () => {
    const repo = new FeatureDocumentRepo(connection.db);
    expect(await repo.findLatestByFeatureId(`feature-${randomUUID()}`)).toBeNull();
  });

  it("ensureIndexes creates a featureId+generatedAt compound index, and is idempotent", async () => {
    const repo = new FeatureDocumentRepo(connection.db);
    await repo.ensureIndexes();
    await repo.ensureIndexes();

    const indexes = await connection.db.collection("featureDocs").indexes();
    expect(indexes.some((index) => index.key.featureId === 1 && index.key.generatedAt === -1)).toBe(true);
  });
});
