import { FindingSchema, type Finding } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { stripUndefinedKeys } from "./mongoDocument.js";

type FindingDocument = Omit<Finding, "id"> & { _id: string };

function toDocument(finding: Finding): FindingDocument {
  const { id, ...rest } = finding;
  return stripUndefinedKeys({ _id: id, ...rest });
}

function fromDocument(document: FindingDocument): Finding {
  const { _id, ...rest } = document;
  return FindingSchema.parse({ id: _id, ...rest });
}

export class FindingRepo {
  private readonly collection: Collection<FindingDocument>;

  constructor(db: Db) {
    this.collection = db.collection<FindingDocument>("findings");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ dedupKey: 1 });
    await this.collection.createIndex({ runId: 1 });
    await this.collection.createIndex({ screenId: 1 });
  }

  async findByDedupKeys(keys: string[]): Promise<Finding[]> {
    if (keys.length === 0) return [];
    const documents = await this.collection.find({ dedupKey: { $in: keys } }).toArray();
    return documents.map(fromDocument);
  }

  async findByScreenIds(screenIds: string[]): Promise<Finding[]> {
    if (screenIds.length === 0) return [];
    const documents = await this.collection.find({ screenId: { $in: screenIds } }).toArray();
    return documents.map(fromDocument);
  }

  async findByRunIds(runIds: string[]): Promise<Finding[]> {
    if (runIds.length === 0) return [];
    const documents = await this.collection.find({ runId: { $in: runIds } }).toArray();
    return documents.map(fromDocument);
  }

  async upsert(finding: Finding): Promise<void> {
    const document = toDocument(FindingSchema.parse(finding));
    await this.collection.replaceOne({ dedupKey: document.dedupKey }, document, { upsert: true });
  }

  async listByRun(runId: string): Promise<Finding[]> {
    const documents = await this.collection.find({ runId }).toArray();
    return documents.map(fromDocument);
  }

  async get(id: string): Promise<Finding | null> {
    const document = await this.collection.findOne({ _id: id });
    return document ? fromDocument(document) : null;
  }

  async hardDelete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
  }

  async deleteByRunIds(runIds: string[]): Promise<void> {
    if (runIds.length === 0) return;
    await this.collection.deleteMany({ runId: { $in: runIds } });
  }
}
