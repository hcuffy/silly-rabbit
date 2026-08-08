import { TestRunSchema, type TestRun } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { z } from "zod";
import { stripUndefinedKeys } from "./mongoDocument.js";

type TestRunDocument = Omit<TestRun, "id"> & { _id: string };

const TestRunPatchSchema = TestRunSchema.omit({ id: true, featureId: true, runId: true, research: true, startedAt: true }).partial();
export type TestRunPatch = z.infer<typeof TestRunPatchSchema>;

function toDocument(testRun: TestRun): TestRunDocument {
  const { id, ...rest } = testRun;
  return stripUndefinedKeys({ _id: id, ...rest });
}

function fromDocument(document: TestRunDocument): TestRun {
  const { _id, ...rest } = document;
  return TestRunSchema.parse({ id: _id, ...rest });
}

export class TestRunRepo {
  private readonly collection: Collection<TestRunDocument>;

  constructor(db: Db) {
    this.collection = db.collection<TestRunDocument>("testRuns");
  }

  async create(testRun: TestRun): Promise<void> {
    await this.collection.insertOne(toDocument(TestRunSchema.parse(testRun)));
  }

  async get(id: string): Promise<TestRun | null> {
    const document = await this.collection.findOne({ _id: id });
    return document ? fromDocument(document) : null;
  }

  async list(pagination: { limit: number; offset: number }): Promise<{ testRuns: TestRun[]; total: number }> {
    const [documents, total] = await Promise.all([
      this.collection.find().sort({ startedAt: -1 }).skip(pagination.offset).limit(pagination.limit).toArray(),
      this.collection.countDocuments(),
    ]);
    return { testRuns: documents.map(fromDocument), total };
  }

  async getByRunId(runId: string): Promise<TestRun | null> {
    const document = await this.collection.findOne({ runId });
    return document ? fromDocument(document) : null;
  }

  async findLatestByFeatureId(featureId: string): Promise<TestRun | null> {
    const document = await this.collection.find({ featureId }).sort({ startedAt: -1 }).limit(1).next();
    return document ? fromDocument(document) : null;
  }

  async update(id: string, patch: TestRunPatch): Promise<void> {
    const parsed = TestRunPatchSchema.parse(patch);
    await this.collection.updateOne({ _id: id }, { $set: parsed });
  }

  async cancel(id: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id, status: { $in: ["PENDING", "RUNNING"] } },
      { $set: { status: "CANCELLED", finishedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ runId: 1 });
    await this.collection.createIndex({ featureId: 1, startedAt: -1 });
    await this.collection.createIndex({ startedAt: -1 });
  }
}
