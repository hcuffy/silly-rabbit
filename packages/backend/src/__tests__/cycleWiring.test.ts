import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Cycle, SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { cancelSessionReplayRun, startSessionReplayRun, type SessionReplayRunLifecycleDeps } from "../sessionReplayRunLifecycle.js";
import { startExplorerRun, type ExplorerRunLifecycleDeps } from "../explorerRunLifecycle.js";
import { startRun, type OrchestratorDeps } from "../orchestrator.js";
import { AppMapRepo } from "../repos/appMapRepo.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { CycleRepo } from "../repos/cycleRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { LearningRepo } from "../repos/learningRepo.js";
import { RunRepo } from "../repos/runRepo.js";
import { SessionRecordingRepo } from "../repos/sessionRecordingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { TestRunRepo } from "../repos/testRunRepo.js";

const DISALLOWED_BASE_URL = "https://not-on-the-allowlist.example.com";
const MOCK_BASE_URL = "http://mock.local/";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test");
      },
    },
  };
}

async function waitForStatus(getStatus: () => Promise<string | undefined>, status: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await getStatus()) === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`never reached status ${status}`);
}

async function waitForRunFailed(runRepo: RunRepo, runId: string): Promise<void> {
  await waitForStatus(async () => (await runRepo.get(runId))?.status, "FAILED");
}

function makeCycle(name: string, runCounter = 0): Cycle {
  return {
    id: randomUUID(),
    name,
    kind: "release",
    status: "active",
    isDefault: false,
    runCounter,
    sessionReplayRunCounter: 0,
    createdAt: new Date(),
  };
}

describe(
  "cycle-field stamping at run-creation time (run-cycles-spec.md §6) — real Mongo, no dashboard/" +
    "CLI/MCP param wiring, direct lifecycle-function calls only",
  () => {
    let mongod: MongoMemoryServer;
    let connection: MongoConnection;
    let cycleRepo: CycleRepo;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      connection = await connectMongo(mongod.getUri());
      cycleRepo = new CycleRepo(connection.db);
      await cycleRepo.ensureIndexes();
    }, 30_000);

    afterAll(async () => {
      await closeMongo(connection);
      await mongod.stop();
    });

    describe("charter runs (orchestrator.ts's startRun)", () => {
      let deps: OrchestratorDeps;

      beforeAll(async () => {
        const reproSpecDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-repro-cyclewiring-"));
        const screenshotDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-screenshot-cyclewiring-"));
        deps = {
          runRepo: new RunRepo(connection.db),
          findingRepo: new FindingRepo(connection.db),
          baselineRepo: new BaselineRepo(connection.db),
          appMapRepo: new AppMapRepo(connection.db),
          cycleRepo,
          reproSpecDirectory,
          screenshotDirectory,
          screenshotStorageCapBytes: 1_000_000_000,
          judgeClientFactory: throwingJudgeClient,
          allowedDomains: [],
          productionUrlPatterns: [],
        };
      });

      it("an explicit cycleId stamps cycleId/cycleRunNumber on the created Run and increments the cycle's runCounter", async () => {
        const cycle = makeCycle("Release 1");
        await cycleRepo.create(cycle);

        const run = await startRun({ charter: "x", targetBaseUrl: DISALLOWED_BASE_URL, cycleId: cycle.id }, deps);

        expect(run.cycleId).toBe(cycle.id);
        expect(run.cycleRunNumber).toBe(1);
        expect((await cycleRepo.get(cycle.id))?.runCounter).toBe(1);
        await waitForRunFailed(deps.runRepo, run.id);
      });

      it(
        "no cycleId given creates a Run exactly as before this feature — cycleId/cycleRunNumber left " +
          "undefined, no Cycle document touched at all",
        async () => {
          const cycle = makeCycle("Release 2");
          await cycleRepo.create(cycle);

          const run = await startRun({ charter: "x", targetBaseUrl: DISALLOWED_BASE_URL }, deps);

          expect(run.cycleId).toBeUndefined();
          expect(run.cycleRunNumber).toBeUndefined();
          expect((await cycleRepo.get(cycle.id))?.runCounter).toBe(0);

          const stored = await connection.db.collection<{ _id: string }>("runs").findOne({ _id: run.id });
          expect(stored).not.toHaveProperty("cycleId");
          expect(stored).not.toHaveProperty("cycleRunNumber");
          await waitForRunFailed(deps.runRepo, run.id);
        },
      );
    });

    describe("explorer runs (explorerRunLifecycle.ts's startExplorerRun)", () => {
      let deps: ExplorerRunLifecycleDeps;

      beforeAll(() => {
        deps = {
          runRepo: new RunRepo(connection.db),
          testRunRepo: new TestRunRepo(connection.db),
          learningRepo: new LearningRepo(connection.db),
          findingRepo: new FindingRepo(connection.db),
          cycleRepo,
          judgeClientFactory: throwingJudgeClient,
          allowedDomains: [],
          productionUrlPatterns: [],
          screenshotDirectory: "/tmp/silly-rabbit-explorer-cyclewiring-screenshots",
          screenshotStorageCapBytes: 1_000_000_000,
        };
      });

      it("an explicit cycleId stamps cycleId/cycleRunNumber, sharing the same runCounter sequence as charter runs on that cycle", async () => {
        const cycle = makeCycle("Release 3", 5);
        await cycleRepo.create(cycle);

        const run = await startExplorerRun({ featureId: "f", sectionDescription: "x", targetBaseUrl: DISALLOWED_BASE_URL, cycleId: cycle.id }, deps);

        expect(run.cycleId).toBe(cycle.id);
        expect(run.cycleRunNumber).toBe(6);
        await waitForRunFailed(deps.runRepo, run.id);
      });

      it("no cycleId given leaves the created Run undefined for both cycle fields", async () => {
        const run = await startExplorerRun({ featureId: "f", sectionDescription: "x", targetBaseUrl: DISALLOWED_BASE_URL }, deps);

        expect(run.cycleId).toBeUndefined();
        expect(run.cycleRunNumber).toBeUndefined();
        await waitForRunFailed(deps.runRepo, run.id);
      });
    });

    describe("session-replay runs (sessionReplayRunLifecycle.ts's startSessionReplayRun)", () => {
      let deps: SessionReplayRunLifecycleDeps;
      let sessionRecordingRepo: SessionRecordingRepo;
      let sessionReplayRunRepo: SessionReplayRunRepo;

      beforeAll(() => {
        sessionRecordingRepo = new SessionRecordingRepo(connection.db);
        sessionReplayRunRepo = new SessionReplayRunRepo(connection.db);
        deps = {
          sessionRecordingRepo,
          sessionReplayRunRepo,
          baselineRepo: new BaselineRepo(connection.db),
          findingRepo: new FindingRepo(connection.db),
          cycleRepo,
          judgeClientFactory: throwingJudgeClient,
          allowedDomains: ["mock.local"],
          productionUrlPatterns: [],
          installRoutes: async (context) => {
            await context.route("**/*", () => new Promise(() => {}));
          },
        };
      });

      async function seedRecording(): Promise<SessionRecording> {
        const sessionRecording: SessionRecording = {
          sessionId: randomUUID(),
          targetBaseUrl: MOCK_BASE_URL,
          recordedAt: new Date(),
          steps: [{ action: "navigate", selectorStrategy: "css", value: MOCK_BASE_URL, timestampOffsetMs: 0 }],
        };
        await sessionRecordingRepo.create(sessionRecording);
        return sessionRecording;
      }

      it(
        "an explicit cycleId stamps cycleId/replayRunNumber (not cycleRunNumber) using a counter " + "independent of the same cycle's runCounter",
        async () => {
          const cycle = makeCycle("Release 4", 9);
          await cycleRepo.create(cycle);
          const recording = await seedRecording();

          const run = await startSessionReplayRun({ sessionId: recording.sessionId, cycleId: cycle.id }, deps);
          if (!run) {
            throw new Error("unreachable — recording was just created");
          }

          expect(run.cycleId).toBe(cycle.id);
          expect(run.replayRunNumber).toBe(1);
          expect((await cycleRepo.get(cycle.id))?.runCounter).toBe(9);

          await waitForStatus(async () => (await sessionReplayRunRepo.get(run.id))?.status, "RUNNING");
          await cancelSessionReplayRun(run.id, deps);
        },
        20_000,
      );

      it(
        "no cycleId given leaves the created SessionReplayRun undefined for both cycle fields, and doesn't " + "create/touch any Cycle document",
        async () => {
          const recording = await seedRecording();

          const run = await startSessionReplayRun({ sessionId: recording.sessionId }, deps);
          if (!run) {
            throw new Error("unreachable — recording was just created");
          }

          expect(run.cycleId).toBeUndefined();
          expect(run.replayRunNumber).toBeUndefined();

          const stored = await connection.db.collection<{ _id: string }>("sessionReplayRuns").findOne({ _id: run.id });
          expect(stored).not.toHaveProperty("cycleId");
          expect(stored).not.toHaveProperty("replayRunNumber");

          await waitForStatus(async () => (await sessionReplayRunRepo.get(run.id))?.status, "RUNNING");
          await cancelSessionReplayRun(run.id, deps);
        },
        20_000,
      );
    });
  },
);
