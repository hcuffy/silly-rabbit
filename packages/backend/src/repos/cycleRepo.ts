import { CycleSchema, type Cycle } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoServerError, type Collection, type Db } from "mongodb";
import { stripUndefinedKeys } from "./mongoDocument.js";

type CycleDocument = Omit<Cycle, "id"> & { _id: string };

const DUPLICATE_KEY_ERROR_CODE = 11000;
const DEFAULT_CYCLE_NAME = "Uncategorized";

function toDocument(cycle: Cycle): CycleDocument {
  const { id, ...rest } = cycle;
  return stripUndefinedKeys({ _id: id, ...rest });
}

function fromDocument(document: CycleDocument): Cycle {
  const { _id, ...rest } = document;
  return CycleSchema.parse({ id: _id, ...rest });
}

export class CycleRepo {
  private readonly collection: Collection<CycleDocument>;

  constructor(db: Db) {
    this.collection = db.collection<CycleDocument>("cycles");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ status: 1 });
    await this.collection.createIndex({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });
  }

  async create(cycle: Cycle): Promise<void> {
    await this.collection.insertOne(toDocument(CycleSchema.parse(cycle)));
  }

  async get(id: string): Promise<Cycle | null> {
    const document = await this.collection.findOne({ _id: id });
    return document ? fromDocument(document) : null;
  }

  async list(filter: { status?: "active" | "archived" } = {}): Promise<Cycle[]> {
    const documents = await this.collection
      .find(stripUndefinedKeys({ ...filter }))
      .sort({ createdAt: 1 })
      .toArray();
    return documents.map(fromDocument);
  }

  async archive(id: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id, isDefault: { $ne: true }, status: "active" },
      { $set: { status: "archived", archivedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async incrementAndGetRunNumber(cycleId: string): Promise<number | undefined> {
    const result = await this.collection.findOneAndUpdate({ _id: cycleId }, { $inc: { runCounter: 1 } }, { returnDocument: "after" });
    return result?.runCounter;
  }

  async incrementAndGetSessionReplayRunNumber(cycleId: string): Promise<number | undefined> {
    const result = await this.collection.findOneAndUpdate({ _id: cycleId }, { $inc: { sessionReplayRunCounter: 1 } }, { returnDocument: "after" });
    return result?.sessionReplayRunCounter;
  }

  async ensureDefaultCycle(): Promise<void> {
    const existing = await this.collection.findOne({ isDefault: true });
    if (existing) {
      return;
    }

    const cycle = CycleSchema.parse({
      id: randomUUID(),
      name: DEFAULT_CYCLE_NAME,
      kind: "release",
      status: "active",
      isDefault: true,
      runCounter: 0,
      sessionReplayRunCounter: 0,
      createdAt: new Date(),
    });

    try {
      await this.collection.insertOne(toDocument(cycle));
    } catch (error) {
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY_ERROR_CODE) {
        return;
      }
      throw error;
    }
  }
}
