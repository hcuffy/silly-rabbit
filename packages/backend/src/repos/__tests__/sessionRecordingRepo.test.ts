import type { SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../../db/connection.js";
import { SessionRecordingRepo } from "../sessionRecordingRepo.js";

interface SessionRecordingDocument {
  _id: string;
  targetBaseUrl: string;
  steps: Array<Record<string, unknown>>;
}

function makeSessionRecording(overrides: Partial<SessionRecording> = {}): SessionRecording {
  return {
    sessionId: randomUUID(),
    targetBaseUrl: "https://dev.rabbit.example",
    recordedAt: new Date(),
    steps: [
      { action: "navigate", selectorStrategy: "css", value: "https://dev.rabbit.example/fleet/locations", timestampOffsetMs: 0 },
      { action: "click", selectorStrategy: "role", role: "link", accessibleName: "Locations", timestampOffsetMs: 800 },
    ],
    ...overrides,
  };
}

describe("SessionRecordingRepo (session-replay-spec §5.1) — mongodb-memory-server, no Docker", () => {
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

  it("round-trips a created SessionRecording, validated against SessionRecordingSchema", async () => {
    const repo = new SessionRecordingRepo(connection.db);
    const sessionRecording = makeSessionRecording();
    await repo.create(sessionRecording);
    expect(await repo.get(sessionRecording.sessionId)).toEqual(sessionRecording);
  });

  it("get returns null for an unknown sessionId", async () => {
    const repo = new SessionRecordingRepo(connection.db);
    expect(await repo.get(randomUUID())).toBeNull();
  });

  it("round-trips a recording with zero steps", async () => {
    const repo = new SessionRecordingRepo(connection.db);
    const sessionRecording = makeSessionRecording({ steps: [] });
    await repo.create(sessionRecording);
    expect(await repo.get(sessionRecording.sessionId)).toEqual(sessionRecording);
  });

  it("round-trips networkCaptures through get() (the read path replay would use)", async () => {
    const repo = new SessionRecordingRepo(connection.db);
    const sessionRecording = makeSessionRecording({
      networkCaptures: [
        {
          url: "https://dev.rabbit.example/api/data",
          method: "GET",
          status: 200,
          bodyPath: "./session-captures/x/0.json",
          timestampOffsetMs: 120,
        },
      ],
    });
    await repo.create(sessionRecording);
    expect(await repo.get(sessionRecording.sessionId)).toEqual(sessionRecording);
  });

  it(
    "strips explicit-undefined optional fields inside each step, not just at the document's top level " +
      "(SessionRecordingStep is this codebase's first array-of-objects-with-optional-fields shape — the " +
      "undefined-serializes-as-null bug class applies per-step, not only to the document root)",
    async () => {
      const repo = new SessionRecordingRepo(connection.db);
      const sessionRecording = makeSessionRecording({
        steps: [
          {
            action: "click",
            selectorStrategy: "css",
            cssSelector: "#save",
            role: undefined,
            accessibleName: undefined,
            value: undefined,
            timestampOffsetMs: 0,
          },
        ],
      });
      await repo.create(sessionRecording);

      const document = await connection.db.collection<SessionRecordingDocument>("sessionRecordings").findOne({ _id: sessionRecording.sessionId });
      expect(document?.steps[0]).not.toHaveProperty("role");
      expect(document?.steps[0]).not.toHaveProperty("accessibleName");
      expect(document?.steps[0]).not.toHaveProperty("value");

      const fetched = await repo.get(sessionRecording.sessionId);
      expect(fetched?.steps[0]?.role).toBeUndefined();
      expect(fetched?.steps[0]?.cssSelector).toBe("#save");
    },
  );

  it("ensureIndexes creates a targetBaseUrl+recordedAt compound index, and is idempotent", async () => {
    const repo = new SessionRecordingRepo(connection.db);
    await repo.ensureIndexes();
    await repo.ensureIndexes();

    const indexes = await connection.db.collection("sessionRecordings").indexes();
    expect(indexes.some((index) => index.key.targetBaseUrl === 1 && index.key.recordedAt === -1)).toBe(true);
  });

  it(
    "list() returns every recording, newest-recorded first (session-replay-spec §8.3 CONFIRM-7: plain " + "list, no filtering/pagination for v1)",
    async () => {
      const repo = new SessionRecordingRepo(connection.db);
      const older = makeSessionRecording({ recordedAt: new Date(Date.now() - 60_000) });
      const newer = makeSessionRecording({ recordedAt: new Date() });
      await repo.create(older);
      await repo.create(newer);

      const list = await repo.list();
      const ids = list.map((recording) => recording.sessionId);
      expect(ids.indexOf(newer.sessionId)).toBeLessThan(ids.indexOf(older.sessionId));
    },
  );

  it("delete() removes the recording entirely (delete-cancel-spec.md, phase 1)", async () => {
    const repo = new SessionRecordingRepo(connection.db);
    const recording = makeSessionRecording();
    await repo.create(recording);
    expect(await repo.get(recording.sessionId)).not.toBeNull();

    await repo.delete(recording.sessionId);
    expect(await repo.get(recording.sessionId)).toBeNull();
  });
});
