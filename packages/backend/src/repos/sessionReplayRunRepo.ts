import { SessionReplayRunSchema, type SessionReplayRun } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { z } from "zod";
import { stripUndefinedKeys } from "./mongoDocument.js";

type SessionReplayRunDocument = Omit<SessionReplayRun, "id"> & { _id: string };

const SessionReplayRunPatchSchema = SessionReplayRunSchema.omit({
  id: true,
  sessionId: true,
  replayMode: true,
  startedAt: true,
}).partial();
export type SessionReplayRunPatch = z.infer<typeof SessionReplayRunPatchSchema>;

function toDocument(run: SessionReplayRun): SessionReplayRunDocument {
  const { id, ...rest } = run;
  return stripUndefinedKeys({ _id: id, ...rest });
}

function fromDocument(document: SessionReplayRunDocument): SessionReplayRun {
  const { _id, ...rest } = document;
  return SessionReplayRunSchema.parse({ id: _id, ...rest });
}

export class SessionReplayRunRepo {
  private readonly collection: Collection<SessionReplayRunDocument>;

  constructor(db: Db) {
    this.collection = db.collection<SessionReplayRunDocument>("sessionReplayRuns");
  }

  async create(run: SessionReplayRun): Promise<void> {
    await this.collection.insertOne(toDocument(SessionReplayRunSchema.parse(run)));
  }

  async get(id: string): Promise<SessionReplayRun | null> {
    const document = await this.collection.findOne({ _id: id });
    return document ? fromDocument(document) : null;
  }

  async list(
    pagination: { limit: number; offset: number; cycleId?: string },
  ): Promise<{ sessionReplayRuns: SessionReplayRun[]; total: number }> {
    const filter = pagination.cycleId ? { cycleId: pagination.cycleId } : {};
    const [documents, total] = await Promise.all([
      this.collection.find(filter).sort({ startedAt: -1 }).skip(pagination.offset).limit(pagination.limit).toArray(),
      this.collection.countDocuments(filter),
    ]);
    return { sessionReplayRuns: documents.map(fromDocument), total };
  }

  async findIdsByCycleId(cycleId: string): Promise<string[]> {
    const documents = await this.collection.find({ cycleId }, { projection: { _id: 1 } }).toArray();
    return documents.map((document) => document._id);
  }

  async update(id: string, patch: SessionReplayRunPatch): Promise<void> {
    const parsed = SessionReplayRunPatchSchema.parse(patch);
    await this.collection.updateOne({ _id: id }, { $set: stripUndefinedKeys(parsed) });
  }

  async cancel(id: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id, status: { $in: ["PENDING", "RUNNING"] } },
      { $set: { status: "CANCELLED", completedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.deleteMany({ _id: { $in: ids } });
  }

  async findBySessionId(sessionId: string): Promise<SessionReplayRun[]> {
    const documents = await this.collection.find({ sessionId }).toArray();
    return documents.map(fromDocument);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ sessionId: 1, startedAt: -1 });
    await this.collection.createIndex({ startedAt: -1 });
  }
}
