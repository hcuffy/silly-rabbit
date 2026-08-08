import { RunSchema, type Run } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { z } from "zod";
import { stripUndefinedKeys } from "./mongoDocument.js";

type RunDocument = Omit<Run, "id"> & { _id: string };

const RunPatchSchema = RunSchema.omit({ id: true, charter: true, targetBaseUrl: true, startedAt: true }).partial();
export type RunPatch = z.infer<typeof RunPatchSchema>;

function toDocument(run: Run): RunDocument {
  const { id, ...rest } = run;
  return stripUndefinedKeys({ _id: id, ...rest });
}

function fromDocument(document: RunDocument): Run {
  const { _id, ...rest } = document;
  return RunSchema.parse({ id: _id, ...rest });
}

export class RunRepo {
  private readonly collection: Collection<RunDocument>;

  constructor(db: Db) {
    this.collection = db.collection<RunDocument>("runs");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ startedAt: -1 });
    await this.collection.createIndex({ targetBaseUrl: 1, startedAt: -1 });
  }

  async create(run: Run): Promise<void> {
    await this.collection.insertOne(toDocument(RunSchema.parse(run)));
  }

  async get(id: string): Promise<Run | null> {
    const document = await this.collection.findOne({ _id: id });
    return document ? fromDocument(document) : null;
  }

  async list(pagination: { limit: number; offset: number; cycleId?: string }): Promise<{ runs: Run[]; total: number }> {
    const filter = pagination.cycleId ? { cycleId: pagination.cycleId } : {};
    const [documents, total] = await Promise.all([
      this.collection.find(filter).sort({ startedAt: -1 }).skip(pagination.offset).limit(pagination.limit).toArray(),
      this.collection.countDocuments(filter),
    ]);
    return { runs: documents.map(fromDocument), total };
  }

  async findIdsByCycleId(cycleId: string): Promise<string[]> {
    const documents = await this.collection.find({ cycleId }, { projection: { _id: 1 } }).toArray();
    return documents.map((document) => document._id);
  }

  async updateStatus(id: string, patch: RunPatch): Promise<void> {
    const parsed = RunPatchSchema.parse(patch);
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

  async findIdsByTargetBaseUrl(targetBaseUrl: string): Promise<string[]> {
    const documents = await this.collection.find({ targetBaseUrl }, { projection: { _id: 1 } }).toArray();
    return documents.map((document) => document._id);
  }
}
