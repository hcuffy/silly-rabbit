import type { SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type RunStoreConnection } from "../runStore.js";
import { SessionRecordingStore } from "../sessionRecordingStore.js";

interface SessionRecordingDocument {
  _id: string;
  targetBaseUrl: string;
  steps: Array<Record<string, unknown>>;
  networkCaptures?: Array<Record<string, unknown>>;
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

describe(
  "SessionRecordingStore (CLI recorder, package-boundary-lighter path — same shape as RunStore, " +
    "session-replay-spec §5.2) — mongodb-memory-server, no Docker",
  () => {
    let mongod: MongoMemoryServer;
    let connection: RunStoreConnection;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await connectMongo(mongod.getUri());
    });

    afterAll(async () => {
      await closeMongo(connection);
      await mongod.stop();
    });

    it("writes to the same 'sessionRecordings' collection the backend's SessionRecordingRepo reads from", async () => {
      const store = new SessionRecordingStore(connection.db);
      const sessionRecording = makeSessionRecording();
      await store.create(sessionRecording);

      const document = await connection.db.collection<SessionRecordingDocument>("sessionRecordings").findOne({ _id: sessionRecording.sessionId });
      expect(document).not.toBeNull();
      expect(document?.targetBaseUrl).toBe(sessionRecording.targetBaseUrl);
      expect(document?.steps).toHaveLength(2);
    });

    it("strips explicit-undefined optional fields inside each step before insert", async () => {
      const store = new SessionRecordingStore(connection.db);
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
      await store.create(sessionRecording);

      const document = await connection.db.collection<SessionRecordingDocument>("sessionRecordings").findOne({ _id: sessionRecording.sessionId });
      expect(document?.steps[0]).not.toHaveProperty("role");
      expect(document?.steps[0]).not.toHaveProperty("value");
    });

    it("round-trips networkCaptures through the same 'sessionRecordings' collection", async () => {
      const store = new SessionRecordingStore(connection.db);
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
      await store.create(sessionRecording);

      const document = await connection.db.collection<SessionRecordingDocument>("sessionRecordings").findOne({ _id: sessionRecording.sessionId });
      expect(document?.networkCaptures).toHaveLength(1);
      expect(document?.networkCaptures?.[0]).toMatchObject({ url: "https://dev.rabbit.example/api/data", status: 200 });
    });
  },
);
