import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Baseline, Finding, SessionRecordingStep } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeSessionReplayStep, type SessionReplayStepInput } from "../sessionReplayExecutor.js";

const RUN_ID = "run-1";
const CHARTER = "session-replay: test-session";

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

describe(
  "executeSessionReplayStep — css-strategy click fail-closed fix (audit finding #1), real chromium. " +
    "Split into its own file to keep sessionReplayExecutor.test.ts under the 250-line lint cap, same " +
    "precedent as boundaryExecutor.buttonTargeting.test.ts.",
  () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser.close();
    });

    it(
      "a css-strategy click step is refused (fail-closed) rather than clicking blind — no accessible " +
        "role/name exists to check against the destructive-action guard for a css-selector target (this " +
        "branch previously called locator.click() unconditionally, bypassing the guard entirely for any " +
        "click whose recorded selector fell back to css)",
      async () => {
        page = await browser.newPage();
        await page.setContent(`<html><body><div id="delete-row" onclick="document.title='clicked'">Delete</div></body></html>`);
        const onBeforeAction = vi.fn();

        const result = await executeSessionReplayStep(
          baseInput(
            page,
            { action: "click", selectorStrategy: "css", cssSelector: "#delete-row", timestampOffsetMs: 0 },
            {
              onBeforeAction,
            },
          ),
        );

        expect(result.status).toBe("drift");
        expect(onBeforeAction).not.toHaveBeenCalled();
        expect(await page.title()).not.toBe("clicked");
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
          type: "BEHAVIOR_CHECK_FAILED",
          origin: "session-replay",
          verdict: "NEEDS_HUMAN",
          severity: "LOW",
        });
        expect(result.findings[0]?.reasoning).toContain("refusing to click blind");
      },
    );

    it(
      "a role-strategy click is unaffected by the css-strategy fail-closed fix above — still routes through " + "onBeforeAction and clicks normally",
      async () => {
        page = await browser.newPage();
        await page.setContent(`<html><body><button aria-label="Save" onclick="document.title='clicked'">Save</button></body></html>`);
        const onBeforeAction = vi.fn();

        const result = await executeSessionReplayStep(
          baseInput(
            page,
            { action: "click", selectorStrategy: "role", role: "button", accessibleName: "Save", timestampOffsetMs: 0 },
            {
              onBeforeAction,
            },
          ),
        );

        expect(result.status).toBe("executed");
        expect(onBeforeAction).toHaveBeenCalledWith({ role: "button", accessibleName: "Save" });
        expect(await page.title()).toBe("clicked");
      },
    );
  },
);
