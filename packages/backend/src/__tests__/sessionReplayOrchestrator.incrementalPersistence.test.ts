import type { AnthropicLike } from "@silly-rabbit/engine";
import type { SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { runSessionReplay, type SessionReplayOrchestratorDeps } from "../sessionReplayOrchestrator.js";

const ALLOWED_URL = "https://replay.local/";

function throwingJudgeClient(): AnthropicLike {
  return {
    messages: {
      create: () => {
        throw new Error("judge should not be called in this test");
      },
    },
  };
}

function makeRecording(overrides: Partial<SessionRecording> = {}): SessionRecording {
  return {
    sessionId: randomUUID(),
    targetBaseUrl: ALLOWED_URL,
    recordedAt: new Date(),
    steps: [],
    ...overrides,
  };
}

describe(
  "runSessionReplay — SessionReplayRun incremental persistence (session-replay-spec §8.3 " +
    "CONFIRM-6, resolved), real chromium + mongodb-memory-server. Split into its own file to keep " +
    "sessionReplayOrchestrator.test.ts under the 250-line lint cap.",
  () => {
    let browser: Browser;
    let page: Page;
    let mongod: MongoMemoryServer;
    let connection: MongoConnection;
    let baselineRepo: BaselineRepo;
    let findingRepo: FindingRepo;
    let sessionReplayRunRepo: SessionReplayRunRepo;

    beforeAll(async () => {
      browser = await chromium.launch();
      mongod = await MongoMemoryServer.create();
      connection = await connectMongo(mongod.getUri());
      baselineRepo = new BaselineRepo(connection.db);
      findingRepo = new FindingRepo(connection.db);
      sessionReplayRunRepo = new SessionReplayRunRepo(connection.db);
    });

    afterAll(async () => {
      await browser.close();
      await closeMongo(connection);
      await mongod.stop();
    });

    function deps(): SessionReplayOrchestratorDeps {
      return {
        baselineRepo,
        findingRepo,
        sessionReplayRunRepo,
        judgeClientFactory: throwingJudgeClient,
        allowedDomains: ["replay.local"],
        productionUrlPatterns: [],
      };
    }

    it(
      "SessionReplayRun status/summary are visible mid-run, before completion — same proof pattern as " +
        "D8's incremental-persistence fix (explorerOrchestrator.resilience.test.ts): don't await the whole " +
        "run first, poll the repo concurrently",
      async () => {
        page = await browser.newPage();
        await page.route(`${ALLOWED_URL}**`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<html><body>
          <h1>Locations</h1>
          <button aria-label="Save">Save</button>
          <input aria-label="Name" />
        </body></html>`,
          }),
        );

        const runId = randomUUID();
        await sessionReplayRunRepo.create({
          id: runId,
          sessionId: randomUUID(),
          replayMode: "live",
          status: "PENDING",
          startedAt: new Date(),
          summary: { stepsExecuted: 0, stepsDrifted: 0, stepsErrored: 0 },
        });

        const recording = makeRecording({
          steps: [
            { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
            { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 500 },
            {
              action: "fill",
              selectorStrategy: "role",
              role: "textbox",
              accessibleName: "Name",
              value: "Main Warehouse",
              timestampOffsetMs: 900,
            },
          ],
        });

        const replayPromise = runSessionReplay({ page, sessionRecording: recording, runId }, deps());

        let observedMidRun = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          const midRun = await sessionReplayRunRepo.get(runId);
          if (midRun && midRun.status === "RUNNING" && midRun.summary.stepsExecuted >= 1 && midRun.summary.stepsExecuted < 3) {
            observedMidRun = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(observedMidRun).toBe(true);

        const summary = await replayPromise;
        expect(summary.stepsExecuted).toBe(3);

        const finalRun = await sessionReplayRunRepo.get(runId);
        expect(finalRun?.status).toBe("COMPLETED");
        expect(finalRun?.completedAt).toBeInstanceOf(Date);
        expect(finalRun?.summary).toEqual({ stepsExecuted: 3, stepsDrifted: 0, stepsErrored: 0 });
      },
      20_000,
    );
  },
);
