import { installMockedReplayRoute, installNavigationGuard, type ActionDescriptor } from "@silly-rabbit/driver";
import type { AnthropicLike } from "@silly-rabbit/engine";
import { buildStepFailureFinding, executeSessionReplayStep, type SessionReplayStepResult } from "@silly-rabbit/explorer";
import type { Finding, SessionRecording } from "@silly-rabbit/shared";
import type { Page } from "playwright";
import type { BaselineRepo } from "./repos/baselineRepo.js";
import type { FindingRepo } from "./repos/findingRepo.js";
import type { SessionReplayRunRepo } from "./repos/sessionReplayRunRepo.js";
import { buildNavigationAllowedCheck } from "./safety.js";

export type SessionReplayMode = "live" | "mocked";

export interface SessionReplayOrchestratorDeps {
  baselineRepo: BaselineRepo;
  findingRepo: FindingRepo;
  sessionReplayRunRepo: SessionReplayRunRepo;
  judgeClientFactory: () => AnthropicLike;
  allowedDomains: string[];
  productionUrlPatterns: RegExp[];
  replayMode?: SessionReplayMode;
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
}

export interface RunSessionReplayInput {
  page: Page;
  sessionRecording: SessionRecording;
  runId: string;
}

export interface SessionReplaySummary {
  stepsExecuted: number;
  stepsDrifted: number;
  stepsErrored: number;
  findings: Finding[];
}

export async function runSessionReplay(input: RunSessionReplayInput, deps: SessionReplayOrchestratorDeps): Promise<SessionReplaySummary> {
  const { page, sessionRecording, runId } = input;
  const charter = `session-replay: ${sessionRecording.sessionId}`;
  const replayMode = deps.replayMode ?? "live";

  await deps.sessionReplayRunRepo.update(runId, { status: "RUNNING" });

  await installNavigationGuard(page, {
    isNavigationAllowed: buildNavigationAllowedCheck(deps.allowedDomains, deps.productionUrlPatterns),
  });
  if (replayMode === "mocked") {
    await installMockedReplayRoute(page, sessionRecording.networkCaptures ?? []);
  }

  const getBaseline = async (screenId: string) => (await deps.baselineRepo.getByScreenIds([screenId]))[0];
  const getExistingFinding = async (dedupKey: string) => (await deps.findingRepo.findByDedupKeys([dedupKey]))[0];

  let stepsExecuted = 0;
  let stepsDrifted = 0;
  let stepsErrored = 0;
  const findings: Finding[] = [];

  /**
   * delete-cancel-spec.md §4 gap fix: reads real current status from Mongo, not a cached
   * in-memory value — the whole race this guards against is cancelSessionReplayRun() writing
   * CANCELLED concurrently, from outside this loop entirely. Checked both between steps (an
   * early-exit optimization — confirmed empirically, not assumed, that every Playwright call
   * against a browser.close()'d page throws immediately, so a subsequent step would already
   * degrade to a step-error result on its own; this just avoids grinding through N more
   * already-doomed steps and their Mongo writes) and, load-bearingly, once more right before
   * the final unconditional status write below (the actual fix — without this second check, a
   * cancel landing after the last step's own check but before this function's final write would
   * still get clobbered).
   */
  const isCancelled = async (): Promise<boolean> => (await deps.sessionReplayRunRepo.get(runId))?.status === "CANCELLED";

  for (const step of sessionRecording.steps) {
    const stepInput = {
      page,
      step,
      runId,
      charter,
      judge: { clientFactory: deps.judgeClientFactory },
      getBaseline,
      getExistingFinding,
      onBeforeNavigate: deps.onBeforeNavigate,
      onBeforeAction: deps.onBeforeAction,
    };

    let result: SessionReplayStepResult;
    try {
      result = await executeSessionReplayStep(stepInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { status: "error", findings: [buildStepFailureFinding(stepInput, `execution error: ${message}`)] };
    }

    if (result.status === "executed") {
      stepsExecuted++;
    } else if (result.status === "drift") {
      stepsDrifted++;
    } else {
      stepsErrored++;
    }

    if (result.newBaseline) {
      await deps.baselineRepo.upsert(result.newBaseline);
    }
    for (const finding of result.findings) {
      const findingWithReplayMode: Finding = { ...finding, replayMode };
      await deps.findingRepo.upsert(findingWithReplayMode);
      findings.push(findingWithReplayMode);
    }

    await deps.sessionReplayRunRepo.update(runId, { summary: { stepsExecuted, stepsDrifted, stepsErrored } });

    if (await isCancelled()) {
      return { stepsExecuted, stepsDrifted, stepsErrored, findings };
    }
  }

  if (await isCancelled()) {
    return { stepsExecuted, stepsDrifted, stepsErrored, findings };
  }
  await deps.sessionReplayRunRepo.update(runId, { status: "COMPLETED", completedAt: new Date() });

  return { stepsExecuted, stepsDrifted, stepsErrored, findings };
}
