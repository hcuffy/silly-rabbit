import type { AnthropicLike, AnthropicMessageResponse } from "@silly-rabbit/engine";
import type { Baseline, Finding, SessionRecordingStep } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeSessionReplayStep, type SessionReplayStepInput } from "../sessionReplayExecutor.js";

const RUN_ID = "run-1";
const CHARTER = "session-replay: test-session";

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

function noBaseline(): Promise<Baseline | undefined> {
  return Promise.resolve(undefined);
}

function noExistingFinding(): Promise<Finding | undefined> {
  return Promise.resolve(undefined);
}

function baseInput(page: Page, step: SessionRecordingStep, overrides: Partial<SessionReplayStepInput> = {}): SessionReplayStepInput {
  return {
    page,
    step,
    runId: RUN_ID,
    charter: CHARTER,
    judge: { clientFactory: throwingJudgeClient },
    getBaseline: noBaseline,
    getExistingFinding: noExistingFinding,
    ...overrides,
  };
}

describe("executeSessionReplayStep (session-replay-spec — replay execution, live mode), real chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("first visit to a screen: no baseline yet, executes cleanly, learns a baseline, no Finding", async () => {
    page = await browser.newPage();
    await page.setContent(`<html><body><h1>Locations</h1><button aria-label="Save">Save</button></body></html>`);

    const result = await executeSessionReplayStep(
      baseInput(page, { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 0 }),
    );

    expect(result.status).toBe("executed");
    expect(result.newBaseline).toBeDefined();
    expect(result.newBaseline?.runId).toBe(RUN_ID);
    expect(result.findings).toHaveLength(0);
  });

  it("matching baseline: no divergence, judge never called, no Finding", async () => {
    page = await browser.newPage();
    await page.setContent(`<html><body><h1>Locations</h1><button aria-label="Save">Save</button></body></html>`);

    const first = await executeSessionReplayStep(
      baseInput(page, { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 0 }),
    );
    const baseline = first.newBaseline;
    expect(baseline).toBeDefined();

    const result = await executeSessionReplayStep(
      baseInput(
        page,
        { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 100 },
        {
          judge: { clientFactory: throwingJudgeClient },
          getBaseline: () => Promise.resolve(baseline),
        },
      ),
    );

    expect(result.status).toBe("executed");
    expect(result.newBaseline).toBeUndefined();
    expect(result.findings).toHaveLength(0);
  });

  it("real divergence: fingerprint differs from baseline, judge is called, Finding.origin is 'session-replay'", async () => {
    page = await browser.newPage();
    await page.setContent(`<html><body><h1>Locations</h1><p>4 rows</p><button aria-label="Refresh">Refresh</button></body></html>`);
    const { screenId, fingerprint, ariaSnapshotMasked } = await learnBaselineFor(page);
    const baseline: Baseline = { screenId, fingerprint, ariaSnapshotMasked, capturedAt: new Date(), runId: "prior-run" };

    await page.setContent(`<html><body><h1>Locations</h1><p>3 rows</p><button aria-label="Refresh">Refresh</button></body></html>`);
    const client = verdictClient({ verdict: "REGRESSION", severity: "MEDIUM", reasoning: "a row went missing", confidence: 0.9 });

    const result = await executeSessionReplayStep(
      baseInput(
        page,
        { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Refresh", timestampOffsetMs: 0 },
        {
          judge: { clientFactory: () => client },
          getBaseline: () => Promise.resolve(baseline),
        },
      ),
    );

    expect(result.status).toBe("executed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      type: "STATE_DIVERGENCE",
      origin: "session-replay",
      verdict: "REGRESSION",
      severity: "MEDIUM",
      reasoning: "a row went missing",
      confidence: 0.9,
      runId: RUN_ID,
    });
  });

  it(
    "a recorded selector that no longer resolves fails closed with a drift Finding — NEEDS_HUMAN/LOW/" +
      "BEHAVIOR_CHECK_FAILED (D8's existing 'couldn't execute' category, per checkExecutionError.ts), " +
      "not a silent skip",
    async () => {
      page = await browser.newPage();
      await page.setContent(`<html><body><h1>Locations</h1></body></html>`);

      const result = await executeSessionReplayStep(
        baseInput(page, {
          action: "click",
          selectorStrategy: "role",
          role: "button",
          accessibleName: "A button that no longer exists",
          timestampOffsetMs: 0,
        }),
      );

      expect(result.status).toBe("drift");
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        type: "BEHAVIOR_CHECK_FAILED",
        origin: "session-replay",
        verdict: "NEEDS_HUMAN",
        severity: "LOW",
        confidence: 0,
        runId: RUN_ID,
      });
      expect(result.findings[0]?.reasoning).toContain("no longer resolves");
    },
  );
});

async function learnBaselineFor(page: Page): Promise<{ screenId: string; fingerprint: string; ariaSnapshotMasked: string }> {
  const result = await executeSessionReplayStep(
    baseInput(page, { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Refresh", timestampOffsetMs: 0 }),
  );
  const baseline = result.newBaseline;
  if (!baseline) {
    throw new Error("test setup: expected a new baseline to be learned");
  }
  return baseline;
}
