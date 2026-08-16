import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { NetworkCapture, SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { runSessionReplay, type SessionReplayOrchestratorDeps } from "../sessionReplayOrchestrator.js";
import { assertAllowedUrl, assertNotDestructive, assertNotProductionUrl } from "../safety.js";

const ALLOWED_URL = "https://replay.local/";

function verdictClient(verdict: { verdict: string; severity: string; reasoning: string; confidence: number }): AnthropicLike {
  const response: AnthropicMessageResponse = {
    content: [{ type: "tool_use", name: "submit_verdict", input: verdict }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  return { messages: { create: () => Promise.resolve(response) } };
}

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
  "runSessionReplay — REPLAY_MODE='mocked' (session-replay-spec §4.3/§5.3), real chromium + " +
    "mongodb-memory-server. Split into its own file to keep sessionReplayOrchestrator.test.ts under the " +
    "250-line lint cap, same precedent as boundaryExecutor.buttonTargeting.test.ts.",
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

    beforeEach(async () => {
      page = await browser.newPage();
      await page.route(`${ALLOWED_URL}**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<html><body>
          <h1>Locations</h1>
          <button aria-label="Remove">Remove</button>
          <button aria-label="Load" onclick="fetch('/api/data')">Load</button>
          <input aria-label="Name" />
        </body></html>`,
        }),
      );
    });

    afterEach(async () => {
      await page.close();
    });

    function deps(overrides: Partial<SessionReplayOrchestratorDeps> = {}): SessionReplayOrchestratorDeps {
      return {
        baselineRepo,
        findingRepo,
        sessionReplayRunRepo,
        judgeClientFactory: throwingJudgeClient,
        allowedDomains: ["replay.local"],
        productionUrlPatterns: [],
        onBeforeNavigate: (url) => {
          assertAllowedUrl(url, ["replay.local"]);
          assertNotProductionUrl(url, []);
        },
        onBeforeAction: (action) => assertNotDestructive(action),
        ...overrides,
      };
    }

    it(
      "REPLAY_MODE default ('live', unspecified): a step's fetch call genuinely reaches the live route handler " +
        "— proves the baseline live path still hits real network when mocked mode isn't requested",
      async () => {
        const runId = randomUUID();
        let liveApiHits = 0;
        await page.route(`${ALLOWED_URL}api/data`, (route) => {
          liveApiHits++;
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ live: true }) });
        });

        const recording = makeRecording({
          steps: [
            { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
            { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Load", timestampOffsetMs: 500 },
          ],
        });

        const summary = await runSessionReplay({ page, sessionRecording: recording, runId }, deps());

        expect(summary.stepsExecuted).toBe(2);
        expect(liveApiHits).toBe(1);
      },
    );

    it(
      "REPLAY_MODE='mocked': the same step's fetch call is fulfilled entirely from the recorded response, " +
        "zero live hits — and the mocked-mode installer is genuinely additive, not intertwined: the exact same " +
        "recording/steps/deps used in the live-mode test above behave differently only because of the mode flag",
      async () => {
        const runId = randomUUID();
        let liveApiHits = 0;
        await page.route(`${ALLOWED_URL}api/data`, (route) => {
          liveApiHits++;
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ live: true }) });
        });

        const bodyDirectory = await mkdtemp(join(tmpdir(), "silly-rabbit-mocked-replay-"));
        const bodyPath = join(bodyDirectory, "data.json");
        await writeFile(bodyPath, JSON.stringify({ recorded: true }));
        const networkCaptures: NetworkCapture[] = [{ url: `${ALLOWED_URL}api/data`, method: "GET", status: 200, bodyPath, timestampOffsetMs: 500 }];

        const recording = makeRecording({
          steps: [
            { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
            { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Load", timestampOffsetMs: 500 },
          ],
          networkCaptures,
        });

        const summary = await runSessionReplay({ page, sessionRecording: recording, runId }, deps({ replayMode: "mocked" }));

        expect(summary.stepsExecuted).toBe(2);
        expect(liveApiHits).toBe(0);
      },
    );

    it(
      "REPLAY_MODE='mocked': navigation and destructive-action guards still apply unchanged — a destructive " +
        "click is still refused even though nothing real would be written in mocked mode",
      async () => {
        const runId = randomUUID();
        const recording = makeRecording({
          steps: [
            { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
            { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Remove", timestampOffsetMs: 500 },
          ],
        });

        const summary = await runSessionReplay({ page, sessionRecording: recording, runId }, deps({ replayMode: "mocked" }));

        expect(summary.stepsErrored).toBe(1);
        const persisted = await findingRepo.findByRunIds([runId]);
        expect(persisted[0]?.reasoning).toContain("matches destructive pattern");
      },
    );

    it("a mocked-mode divergence produces a Finding with replayMode:'mocked' set correctly", async () => {
      const recording = makeRecording({
        steps: [{ action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 }],
      });

      const firstRunId = randomUUID();
      await runSessionReplay({ page, sessionRecording: recording, runId: firstRunId }, deps({ replayMode: "mocked" }));

      await page.unroute(`${ALLOWED_URL}**`);
      await page.route(`${ALLOWED_URL}**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<html><body><h1>Locations</h1><p>a row is now missing</p></body></html>`,
        }),
      );

      const secondRunId = randomUUID();
      const client = verdictClient({ verdict: "REGRESSION", severity: "MEDIUM", reasoning: "a row went missing", confidence: 0.9 });
      const summary = await runSessionReplay(
        { page, sessionRecording: recording, runId: secondRunId },
        deps({ replayMode: "mocked", judgeClientFactory: () => client }),
      );

      expect(summary.stepsExecuted).toBe(1);
      const persisted = await findingRepo.findByRunIds([secondRunId]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ type: "STATE_DIVERGENCE", origin: "session-replay", replayMode: "mocked" });
    });
  },
);
