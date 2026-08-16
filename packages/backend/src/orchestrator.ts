import { deriveScreenId, runEngineLoop, type AnthropicLike, type CapturedObservation } from "@silly-rabbit/engine";
import { explore, getTriggeredBy, type ActionDescriptor, type CharterNavConfig, type LoginCreds } from "@silly-rabbit/driver";
import type { AppMap, AppMapScreen, Run } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { resolveRunCycleFields } from "./cycleAssignment.js";
import type { AppMapRepo } from "./repos/appMapRepo.js";
import type { BaselineRepo } from "./repos/baselineRepo.js";
import type { CycleRepo } from "./repos/cycleRepo.js";
import type { FindingRepo } from "./repos/findingRepo.js";
import type { RunRepo } from "./repos/runRepo.js";
import { attachBaselineScreenshots, attachReproSpecs, attachScreenshots, type ScreenInfo, type ScreenshotStorageOptions } from "./runArtifacts.js";
import { reserveRunSlot, trackInFlightRun } from "./runConcurrency.js";
import {
  assertAllowedUrl,
  assertNotDestructive,
  assertNotProductionUrl,
  buildNavigationAllowedCheck,
  DEFAULT_DESTRUCTIVE_PATTERNS,
} from "./safety.js";

export { RunCapacityError, waitForInFlightRuns, trackInFlightRun, reserveRunSlot } from "./runConcurrency.js";

export interface OrchestratorDeps {
  runRepo: RunRepo;
  findingRepo: FindingRepo;
  baselineRepo: BaselineRepo;
  appMapRepo: AppMapRepo;
  cycleRepo?: CycleRepo;
  reproSpecDirectory: string;
  screenshotDirectory: string;
  screenshotStorageCapBytes: number;
  judgeClientFactory: () => AnthropicLike;
  maxLlmCalls?: number;
  maxUsdPerRun?: number;
  maxConcurrentRuns?: number;
  allowedDomains: string[];
  productionUrlPatterns: RegExp[];
  destructivePatterns?: string[];
  maxSteps?: number;
  loginCreds?: LoginCreds;
  storageState?: string;
  installRoutes?: (context: BrowserContext) => Promise<void>;
  charterNav?: CharterNavConfig;
}

export interface StartRunInput {
  charter: string;
  targetBaseUrl: string;
  cycleId?: string;
}

interface CancellationEntry {
  browser?: Browser;
  cancelRequested: boolean;
  jobSettled?: Promise<void>;
}

const runCancellationRegistry = new Map<string, CancellationEntry>();

/**
 * Atomically flips the DB status first (RunRepo.cancel's conditional update is the single
 * source of truth for "was this actually cancellable") — only if that succeeds does this touch
 * the in-memory registry, so a run that already reached COMPLETED/FAILED is never disturbed.
 * PENDING (no browser yet) and RUNNING (browser launched) both come through here; executeRun's
 * own two checkpoints (before and immediately after chromium.launch()) are what make the
 * PENDING case actually prevent the launch, not just flip a status the run ignores.
 */
export async function cancelRun(id: string, deps: OrchestratorDeps): Promise<boolean> {
  const cancelled = await deps.runRepo.cancel(id);
  if (!cancelled) {
    return false;
  }

  const entry = runCancellationRegistry.get(id);
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

export async function startRun(input: StartRunInput, deps: OrchestratorDeps): Promise<Run> {
  const releaseSlot = reserveRunSlot(deps.maxConcurrentRuns);
  try {
    const cycleFields = await resolveRunCycleFields(input.cycleId, deps.cycleRepo);
    const run: Run = {
      id: randomUUID(),
      charter: input.charter,
      targetBaseUrl: input.targetBaseUrl,
      status: "PENDING",
      startedAt: new Date(),
      stepsUsed: 0,
      llmCallsUsed: 0,
      costUsd: 0,
      triggeredBy: getTriggeredBy(),
      ...cycleFields,
    };
    await deps.runRepo.create(run);

    const job: Promise<void> = executeRun(run, deps);
    trackInFlightRun(job);
    // executeRun's own first line already registered its CancellationEntry synchronously —
    // safe to attach the job promise to it right here, no race.
    const registryEntry = runCancellationRegistry.get(run.id);
    if (registryEntry) {
      registryEntry.jobSettled = job;
    }

    return run;
  } finally {
    releaseSlot();
  }
}

async function persistAppMap(screens: ScreenInfo[], baseUrl: string, appMapRepo: AppMapRepo): Promise<void> {
  const existing = await appMapRepo.get();
  const knownScreenIds = new Set((existing?.screens ?? []).map((screen) => screen.screenId));
  const now = new Date();

  const discovered: AppMapScreen[] = [];
  for (const screen of screens) {
    if (knownScreenIds.has(screen.screenId)) {
      continue;
    }
    knownScreenIds.add(screen.screenId);
    discovered.push({
      screenId: screen.screenId,
      normalizedUrl: screen.normalizedUrl,
      headingAnchor: screen.headingAnchor,
      discoveredAt: now,
    });
  }

  if (!existing && discovered.length === 0) {
    return;
  }

  const appMap: AppMap = {
    id: existing?.id ?? randomUUID(),
    baseUrl,
    screens: [...(existing?.screens ?? []), ...discovered],
  };
  await appMapRepo.upsert(appMap);
}

async function runFailed(run: Run, deps: OrchestratorDeps, error: unknown): Promise<void> {
  try {
    await deps.runRepo.updateStatus(run.id, {
      status: "FAILED",
      finishedAt: new Date(),
      error: error instanceof Error ? error.message : String(error),
    });
  } catch (updateError) {
    console.error("orchestrator: failed to persist FAILED status for run", run.id, updateError);
  }
}

async function executeRun(run: Run, deps: OrchestratorDeps): Promise<void> {
  const registryEntry: CancellationEntry = { cancelRequested: false };
  runCancellationRegistry.set(run.id, registryEntry);
  try {
    await deps.runRepo.updateStatus(run.id, { status: "RUNNING" });

    assertAllowedUrl(run.targetBaseUrl, deps.allowedDomains);
    assertNotProductionUrl(run.targetBaseUrl, deps.productionUrlPatterns);
    if (deps.loginCreds) {
      assertAllowedUrl(deps.loginCreds.loginUrl, deps.allowedDomains);
      assertNotProductionUrl(deps.loginCreds.loginUrl, deps.productionUrlPatterns);
    }

    const destructivePatterns = deps.destructivePatterns ?? DEFAULT_DESTRUCTIVE_PATTERNS;

    let storageState: string | undefined;
    if (!deps.loginCreds && deps.storageState && existsSync(deps.storageState)) {
      storageState = deps.storageState;
    }

    if (registryEntry.cancelRequested) {
      return;
    } // cancelled while PENDING — CANCELLED already written by cancelRun()

    const browser = await chromium.launch();
    if (registryEntry.cancelRequested) {
      await browser.close();
      return; // cancelled during launch — CANCELLED already written by cancelRun()
    }
    registryEntry.browser = browser;

    let observations: CapturedObservation[];
    try {
      observations = await explore({
        charter: run.charter,
        baseUrl: run.targetBaseUrl,
        browser,
        loginCreds: deps.loginCreds,
        storageState,
        installRoutes: deps.installRoutes,
        maxSteps: deps.maxSteps,
        charterNav: deps.charterNav,
        onBeforeNavigate: (url) => {
          assertAllowedUrl(url, deps.allowedDomains);
          assertNotProductionUrl(url, deps.productionUrlPatterns);
        },
        onBeforeAction: (action: ActionDescriptor) => assertNotDestructive(action, destructivePatterns),
        isNavigationAllowed: buildNavigationAllowedCheck(deps.allowedDomains, deps.productionUrlPatterns),
      });
    } finally {
      await browser.close();
    }

    const screens: ScreenInfo[] = observations.map((observation) => ({
      observation,
      ...deriveScreenId(observation),
    }));
    const screenIds = screens.map((screen) => screen.screenId);

    const [existingBaselines, existingFindings] = await Promise.all([
      deps.baselineRepo.getByScreenIds(screenIds),
      deps.findingRepo.findByScreenIds(screenIds),
    ]);

    const output = await runEngineLoop({
      runId: run.id,
      charter: run.charter,
      observations,
      existingBaselines,
      existingFindings,
      judge: { clientFactory: deps.judgeClientFactory },
      maxLlmCalls: deps.maxLlmCalls,
      maxUsdPerRun: deps.maxUsdPerRun,
    });

    const screenshotStorage: ScreenshotStorageOptions = {
      screenshotDirectory: deps.screenshotDirectory,
      screenshotStorageCapBytes: deps.screenshotStorageCapBytes,
    };
    const findingsWithRepro = await attachReproSpecs(output.findings, screens, deps.reproSpecDirectory);
    const findingsWithScreenshots = await attachScreenshots(findingsWithRepro, screens, screenshotStorage);
    const baselinesWithScreenshots = await attachBaselineScreenshots(output.baselines, screens, screenshotStorage);
    await Promise.all(baselinesWithScreenshots.map((baseline) => deps.baselineRepo.upsert(baseline)));
    await Promise.all(findingsWithScreenshots.map((finding) => deps.findingRepo.upsert(finding)));
    await persistAppMap(screens, run.targetBaseUrl, deps.appMapRepo);

    await deps.runRepo.updateStatus(run.id, {
      status: "COMPLETED",
      finishedAt: new Date(),
      stepsUsed: observations.length,
      llmCallsUsed: output.llmCallsUsed,
      costUsd: output.costUsd,
    });
  } catch (error) {
    if (registryEntry.cancelRequested) {
      return;
    } // CANCELLED already written by cancelRun(), not a real failure
    await runFailed(run, deps, error);
  } finally {
    runCancellationRegistry.delete(run.id);
  }
}
