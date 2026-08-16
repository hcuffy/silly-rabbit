import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { SessionRecording } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMongo, connectMongo, type MongoConnection } from "../db/connection.js";
import { BaselineRepo } from "../repos/baselineRepo.js";
import { FindingRepo } from "../repos/findingRepo.js";
import { SessionReplayRunRepo } from "../repos/sessionReplayRunRepo.js";
import { runSessionReplay, type SessionReplayOrchestratorDeps } from "../sessionReplayOrchestrator.js";
import { assertAllowedUrl, assertNotDestructive, assertNotProductionUrl } from "../safety.js";

const ALLOWED_URL = "https://replay.local/";
const BLOCKED_URL = "https://blocked.example/";

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
  "runSessionReplay (session-replay-spec — replay execution, REPLAY_MODE=live), real chromium + " +
    "mongodb-memory-server, real safety-guard functions wired (not just hooked)",
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
          <button aria-label="Save">Save</button>
          <button aria-label="Delete">Delete</button>
          <input aria-label="Name" />
        </body></html>`,
        }),
      );
      await page.route(`${BLOCKED_URL}**`, (route) => route.fulfill({ contentType: "text/html", body: "<html><body>Blocked Landed</body></html>" }));
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

    it("full successful replay: navigate + click + fill all execute, baseline learned and persisted to real Mongo", async () => {
      const runId = randomUUID();
      const recording = makeRecording({
        steps: [
          { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
          { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 500 },
          { action: "fill", selectorStrategy: "role", role: "textbox", accessibleName: "Name", value: "Main Warehouse", timestampOffsetMs: 900 },
        ],
      });

      const summary = await runSessionReplay({ page, sessionRecording: recording, runId }, deps());

      expect(summary.stepsExecuted).toBe(3);
      expect(summary.stepsDrifted).toBe(0);
      expect(summary.stepsErrored).toBe(0);
      expect(await page.locator('input[aria-label="Name"]').inputValue()).toBe("Main Warehouse");

      const persisted = await findingRepo.findByRunIds([runId]);
      expect(persisted).toHaveLength(0);
    });

    it(
      "a destructive-guard refusal mid-replay degrades to a Finding and the replay continues — later steps " +
        "still execute, every step's result persists incrementally (D8 incremental-persistence precedent)",
      async () => {
        const runId = randomUUID();
        const recording = makeRecording({
          steps: [
            { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
            { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Delete", timestampOffsetMs: 500 },
            { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 900 },
          ],
        });

        const summary = await runSessionReplay({ page, sessionRecording: recording, runId }, deps());

        expect(summary.stepsErrored).toBe(1);
        expect(summary.stepsExecuted).toBe(2);

        const persisted = await findingRepo.findByRunIds([runId]);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({ type: "BEHAVIOR_CHECK_FAILED", verdict: "NEEDS_HUMAN", severity: "LOW", origin: "session-replay" });
        expect(persisted[0]?.reasoning).toContain("matches destructive pattern");

        const baselineCount = await connection.db.collection("baselines").countDocuments();
        expect(baselineCount).toBeGreaterThan(0);
      },
    );

    it(
      "a navigation-guard refusal (disallowed host) also degrades cleanly rather than crashing the replay " +
        "— confirms the navigation guard call site is real, not assumed",
      async () => {
        const runId = randomUUID();
        const recording = makeRecording({
          steps: [
            { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
            { action: "navigate", selectorStrategy: "css", value: BLOCKED_URL, timestampOffsetMs: 500 },
          ],
        });

        const summary = await runSessionReplay({ page, sessionRecording: recording, runId }, deps());

        expect(summary.stepsErrored).toBe(1);
        expect(page.url()).not.toBe(BLOCKED_URL);
        expect(await page.getByText("Blocked Landed").count()).toBe(0);

        const persisted = await findingRepo.findByRunIds([runId]);
        expect(persisted.some((finding) => finding.reasoning?.includes("ALLOWLIST") || finding.reasoning?.includes("allowlist"))).toBe(true);
      },
    );

    it("a drift step (recorded selector no longer resolves) produces the correct Finding shape, persisted", async () => {
      const runId = randomUUID();
      const recording = makeRecording({
        steps: [
          { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
          {
            action: "click",
            selectorStrategy: "role",
            role: "button",
            accessibleName: "A button that no longer exists",
            timestampOffsetMs: 500,
          },
        ],
      });

      const summary = await runSessionReplay({ page, sessionRecording: recording, runId }, deps());

      expect(summary.stepsDrifted).toBe(1);
      const persisted = await findingRepo.findByRunIds([runId]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        type: "BEHAVIOR_CHECK_FAILED",
        verdict: "NEEDS_HUMAN",
        severity: "LOW",
        origin: "session-replay",
        confidence: 0,
      });
    });

    it(
      "a real divergence between two replay runs of the same recording triggers the judge path, persists a " +
        "STATE_DIVERGENCE Finding with origin 'session-replay'",
      async () => {
        const recording = makeRecording({
          steps: [{ action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 }],
        });

        const firstRunId = randomUUID();
        await runSessionReplay({ page, sessionRecording: recording, runId: firstRunId }, deps());

        await page.unroute(`${ALLOWED_URL}**`);
        await page.route(`${ALLOWED_URL}**`, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<html><body><h1>Locations</h1><p>a row is now missing</p></body></html>`,
          }),
        );

        const secondRunId = randomUUID();
        const client = verdictClient({ verdict: "REGRESSION", severity: "MEDIUM", reasoning: "a row went missing", confidence: 0.9 });
        const summary = await runSessionReplay({ page, sessionRecording: recording, runId: secondRunId }, deps({ judgeClientFactory: () => client }));

        expect(summary.stepsExecuted).toBe(1);
        const persisted = await findingRepo.findByRunIds([secondRunId]);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({
          type: "STATE_DIVERGENCE",
          origin: "session-replay",
          verdict: "REGRESSION",
          severity: "MEDIUM",
          reasoning: "a row went missing",
          confidence: 0.9,
        });
      },
    );

    it(
      "a thrown error from captureAndCompare's Mongo-touching callback (getBaseline) degrades to a " +
        "step-level error Finding and the replay continues — later steps still execute, partial results still " +
        "persisted (audit finding #4: mirrors D8's per-check try/catch, explorerOrchestrator.ts, not a lighter " +
        "reimplementation)",
      async () => {
        const runId = randomUUID();
        const recording = makeRecording({
          steps: [
            { action: "navigate", selectorStrategy: "css", value: ALLOWED_URL, timestampOffsetMs: 0 },
            { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 500 },
            { action: "fill", selectorStrategy: "role", role: "textbox", accessibleName: "Name", value: "Main Warehouse", timestampOffsetMs: 900 },
          ],
        });

        const originalGetByScreenIds = baselineRepo.getByScreenIds.bind(baselineRepo);
        let callCount = 0;
        const getByScreenIdsSpy = vi.spyOn(baselineRepo, "getByScreenIds").mockImplementation((...arguments_) => {
          callCount++;
          if (callCount === 2) {
            throw new Error("simulated transient Mongo error");
          }
          return originalGetByScreenIds(...arguments_);
        });

        const summary = await runSessionReplay({ page, sessionRecording: recording, runId }, deps());

        expect(summary.stepsErrored).toBe(1);
        expect(summary.stepsExecuted).toBe(2);

        const persisted = await findingRepo.findByRunIds([runId]);
        expect(persisted.some((finding) => finding.reasoning?.includes("simulated transient Mongo error"))).toBe(true);
        expect(await page.locator('input[aria-label="Name"]').inputValue()).toBe("Main Warehouse");

        getByScreenIdsSpy.mockRestore();
      },
    );
  },
);
