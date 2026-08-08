import { SessionRecordingSchema, type SessionRecording } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { stripUndefinedKeys } from "./mongoDocument.js";

type SessionRecordingDocument = Omit<SessionRecording, "sessionId"> & { _id: string };

function toDocument(sessionRecording: SessionRecording): SessionRecordingDocument {
  const { sessionId, steps, ...rest } = sessionRecording;
  return stripUndefinedKeys({
    _id: sessionId,
    ...rest,
    steps: steps.map((step) => stripUndefinedKeys({ ...step })),
  });
}

function fromDocument(document: SessionRecordingDocument): SessionRecording {
  const { _id, ...rest } = document;
  return SessionRecordingSchema.parse({ sessionId: _id, ...rest });
}

export class SessionRecordingRepo {
  private readonly collection: Collection<SessionRecordingDocument>;

  constructor(db: Db) {
    this.collection = db.collection<SessionRecordingDocument>("sessionRecordings");
  }

  async create(sessionRecording: SessionRecording): Promise<void> {
    await this.collection.insertOne(toDocument(SessionRecordingSchema.parse(sessionRecording)));
  }

  async get(sessionId: string): Promise<SessionRecording | null> {
    const document = await this.collection.findOne({ _id: sessionId });
    return document ? fromDocument(document) : null;
  }

  async list(): Promise<SessionRecording[]> {
    const documents = await this.collection.find().sort({ recordedAt: -1 }).toArray();
    return documents.map(fromDocument);
  }

  async delete(sessionId: string): Promise<void> {
    await this.collection.deleteOne({ _id: sessionId });
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ targetBaseUrl: 1, recordedAt: -1 });
  }
}
