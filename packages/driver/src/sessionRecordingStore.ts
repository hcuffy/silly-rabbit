import { SessionRecordingSchema, type SessionRecording } from "@silly-rabbit/shared";
import type { Collection, Db } from "mongodb";
import { stripUndefinedKeys } from "./runStore.js";

type SessionRecordingDocument = Omit<SessionRecording, "sessionId"> & { _id: string };

function toDocument(sessionRecording: SessionRecording): SessionRecordingDocument {
  const { sessionId, steps, ...rest } = sessionRecording;
  return stripUndefinedKeys({
    _id: sessionId,
    ...rest,
    steps: steps.map((step) => stripUndefinedKeys({ ...step })),
  });
}

export class SessionRecordingStore {
  private readonly collection: Collection<SessionRecordingDocument>;

  constructor(db: Db) {
    this.collection = db.collection<SessionRecordingDocument>("sessionRecordings");
  }

  async create(sessionRecording: SessionRecording): Promise<void> {
    await this.collection.insertOne(toDocument(SessionRecordingSchema.parse(sessionRecording)));
  }
}
