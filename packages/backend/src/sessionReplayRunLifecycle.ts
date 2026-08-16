import { installNavigationGuard, type ActionDescriptor } from "@silly-rabbit/driver";
import type { AnthropicLike } from "@silly-rabbit/engine";
import type { SessionRecording, SessionReplayRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { resolveSessionReplayRunCycleFields } from "./cycleAssignment.js";
import { runSessionReplay, type SessionReplayMode } from "./sessionReplayOrchestrator.js";
import { reserveRunSlot, trackInFlightRun } from "./orchestrator.js";
import type { BaselineRepo } from "./repos/baselineRepo.js";
import type { CycleRepo } from "./repos/cycleRepo.js";
import type { FindingRepo } from "./repos/findingRepo.js";
import type { SessionRecordingRepo } from "./repos/sessionRecordingRepo.js";
import type { SessionReplayRunRepo } from "./repos/sessionReplayRunRepo.js";
import { assertAllowedUrl, assertNotDestructive, assertNotProductionUrl, buildNavigationAllowedCheck } from "./safety.js";

export interface SessionReplayRunLifecycleDeps {
  sessionRecordingRepo: SessionRecordingRepo;
  sessionReplayRunRepo: SessionReplayRunRepo;
  baselineRepo: BaselineRepo;
  findingRepo: FindingRepo;
  judgeClientFactory: () => AnthropicLike;
  allowedDomains: string[];
  productionUrlPatterns: RegExp[];
  installRoutes?: (context: BrowserContext) => Promise<void>;
  maxConcurrentRuns?: number;
  cycleRepo?: CycleRepo;
}

interface CancellationEntry {
  browser?: Browser;
  cancelRequested: boolean;
  jobSettled?: Promise<void>;
}

const sessionReplayCancellationRegistry = new Map<string, CancellationEntry>();

export async function cancelSessionReplayRun(id: string, deps: SessionReplayRunLifecycleDeps): Promise<boolean> {
  const cancelled = await deps.sessionReplayRunRepo.cancel(id);
  if (!cancelled) {
    return false;
  }

  const entry = sessionReplayCancellationRegistry.get(id);
  if (entry) {
    entry.cancelRequested = true;
    if (entry.browser) {
      await entry.browser.close();
    }
    if (entry.jobSettled) {
      await entry.jobSettled.catch(() => {});
    }
  }
  return true;
}

export interface StartSessionReplayRunInput {
  sessionId: string;
  replayMode?: SessionReplayMode;
  cycleId?: string;
}

export async function startSessionReplayRun(
  input: StartSessionReplayRunInput,
  deps: SessionReplayRunLifecycleDeps,
): Promise<SessionReplayRun | undefined> {
  const sessionRecording = await deps.sessionRecordingRepo.get(input.sessionId);
  if (!sessionRecording) {
    return undefined;
  }

  const releaseSlot = reserveRunSlot(deps.maxConcurrentRuns);
  try {
    const cycleFields = await resolveSessionReplayRunCycleFields(input.cycleId, deps.cycleRepo);
    const run: SessionReplayRun = {
      id: randomUUID(),
      sessionId: input.sessionId,
      replayMode: input.replayMode ?? "live",
      status: "PENDING",
      startedAt: new Date(),
      summary: { stepsExecuted: 0, stepsDrifted: 0, stepsErrored: 0 },
      ...cycleFields,
    };
    await deps.sessionReplayRunRepo.create(run);

    const job = executeSessionReplayRun(run, sessionRecording, deps);
    trackInFlightRun(job);
    // executeSessionReplayRun's own first line already registered its CancellationEntry
    // synchronously — safe to attach the job promise to it right here, no race.
    const registryEntry = sessionReplayCancellationRegistry.get(run.id);
    if (registryEntry) {
      registryEntry.jobSettled = job;
    }

    return run;
  } finally {
    releaseSlot();
  }
}

async function executeSessionReplayRun(
  run: SessionReplayRun,
  sessionRecording: SessionRecording,
  deps: SessionReplayRunLifecycleDeps,
): Promise<void> {
  const registryEntry: CancellationEntry = { cancelRequested: false };
  sessionReplayCancellationRegistry.set(run.id, registryEntry);

  const browser = await chromium.launch();
  if (registryEntry.cancelRequested) {
    await browser.close();
    sessionReplayCancellationRegistry.delete(run.id);
    return; // cancelled during launch — CANCELLED already written by cancelSessionReplayRun()
  }
  registryEntry.browser = browser;
  try {
    const context = await browser.newContext();
    if (deps.installRoutes) {
      await deps.installRoutes(context);
    }

    const page = await context.newPage();
    await installNavigationGuard(page, {
      isNavigationAllowed: buildNavigationAllowedCheck(deps.allowedDomains, deps.productionUrlPatterns),
    });

    const onBeforeNavigate = (url: string): void => {
      assertAllowedUrl(url, deps.allowedDomains);
      assertNotProductionUrl(url, deps.productionUrlPatterns);
    };
    const onBeforeAction = (action: ActionDescriptor): void => assertNotDestructive(action);

    await runSessionReplay(
      { page, sessionRecording, runId: run.id },
      {
        baselineRepo: deps.baselineRepo,
        findingRepo: deps.findingRepo,
        sessionReplayRunRepo: deps.sessionReplayRunRepo,
        judgeClientFactory: deps.judgeClientFactory,
        allowedDomains: deps.allowedDomains,
        productionUrlPatterns: deps.productionUrlPatterns,
        replayMode: run.replayMode,
        onBeforeNavigate,
        onBeforeAction,
      },
    );
  } catch (error) {
    if (registryEntry.cancelRequested) {
      return;
    } // CANCELLED already written by cancelSessionReplayRun(), not a real failure
    await deps.sessionReplayRunRepo.update(run.id, {
      status: "FAILED",
      completedAt: new Date(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await browser.close();
    sessionReplayCancellationRegistry.delete(run.id);
  }
}
