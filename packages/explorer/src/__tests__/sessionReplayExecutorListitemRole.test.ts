import type { AnthropicLike } from "@silly-rabbit/engine";
import type { Baseline, Finding, SessionRecordingStep } from "@silly-rabbit/shared";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeSessionReplayStep, type SessionReplayStepInput } from "../sessionReplayExecutor.js";

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

function baseInput(page: Page, step: SessionRecordingStep): SessionReplayStepInput {
  return {
    page,
    step,
    runId: "run-1",
    charter: "session-replay: test-session",
    judge: { clientFactory: throwingJudgeClient },
    getBaseline: noBaseline,
    getExistingFinding: noExistingFinding,
  };
}

describe("resolveReplayLocator — role=listitem fallback + PUA glyph, real chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("a listitem-role step falls back to hasText matching when getByRole(name:) resolves to zero " +
    "(a pre-existing, glyph-unrelated Chromium quirk confirmed via a plain glyph-free control test) — and " +
    "correctly strips a PUA icon-ligature glyph from the fallback's own locator regex, same discipline as " +
    "resolveMatch's fix", async () => {
    page = await browser.newPage();
    await page.setContent(
      `<html><head><style>.icon::before { content: "\\e939"; }</style></head><body><ul>
        <li><i class="icon"></i> Standorte</li>
      </ul></body></html>`,
    );

    const result = await executeSessionReplayStep(
      baseInput(page, {
        action: "click",
        selectorStrategy: "role",
        role: "listitem",
        accessibleName: "\u{E939} Standorte",
        timestampOffsetMs: 0,
      }),
    );

    expect(result.status).toBe("executed");
    expect(result.findings).toHaveLength(0);
  });
});
