import { getTriggeredBy, installNavigationGuard, login, type ActionDescriptor, type LoginCreds } from "@silly-rabbit/driver";
import { locateSection, sweepNavMapEntries, trackClientUsage } from "@silly-rabbit/explorer";
import type { NavMap, NavMapEntry, Run } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolveRunCycleFields } from "./cycleAssignment.js";
import { runExplorerTestRun, type ExplorerOrchestratorDeps } from "./explorerOrchestrator.js";
import { reserveRunSlot, trackInFlightRun } from "./orchestrator.js";
import type { CycleRepo } from "./repos/cycleRepo.js";
import type { NavMapRepo } from "./repos/navMapRepo.js";
import type { RunRepo } from "./repos/runRepo.js";
import { assertAllowedUrl, assertNotProductionUrl, buildNavigationAllowedCheck } from "./safety.js";

export interface ExplorerRunLifecycleDeps extends ExplorerOrchestratorDeps {
  runRepo: RunRepo;
  loginCreds?: LoginCreds;
  installRoutes?: (context: BrowserContext) => Promise<void>;
  maxConcurrentRuns?: number;
  navMapRepo?: NavMapRepo;
  cycleRepo?: CycleRepo;
}

interface CancellationEntry {
  browser?: Browser;
  cancelRequested: boolean;
  jobSettled?: Promise<void>;
}

const explorerCancellationRegistry = new Map<string, CancellationEntry>();

export async function cancelExplorerRun(runId: string, deps: ExplorerRunLifecycleDeps): Promise<boolean> {
  const cancelled = await deps.runRepo.cancel(runId);
  if (!cancelled) {
    return false;
  }

  const testRun = await deps.testRunRepo.getByRunId(runId);
  if (testRun) {
    await deps.testRunRepo.cancel(testRun.id);
  }

  const entry = explorerCancellationRegistry.get(runId);
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

export interface StartExplorerRunInput {
  featureId: string;
  sectionDescription: string;
  targetBaseUrl: string;
  cycleId?: string;
}

export async function startExplorerRun(input: StartExplorerRunInput, deps: ExplorerRunLifecycleDeps): Promise<Run> {
  const releaseSlot = reserveRunSlot(deps.maxConcurrentRuns);
  try {
    const cycleFields = await resolveRunCycleFields(input.cycleId, deps.cycleRepo);
    const run: Run = {
      id: randomUUID(),
      charter: `explorer: ${input.featureId} — "${input.sectionDescription}"`,
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

    const job = executeExplorerRun(run, input, deps);
    trackInFlightRun(job);
    // executeExplorerRun's own first line already registered its CancellationEntry synchronously —
    // safe to attach the job promise to it right here, no race (same reasoning as orchestrator.ts).
    const registryEntry = explorerCancellationRegistry.get(run.id);
    if (registryEntry) {
      registryEntry.jobSettled = job;
    }

    return run;
  } finally {
    releaseSlot();
  }
}

interface NavMapSweepAfterRunInput {
  page: Page;
  navMap: NavMap;
  navMapRepo: NavMapRepo;
  usedEntry: NavMapEntry | undefined;
  onBeforeNavigate: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
}

async function sweepAndPersistNavMap(input: NavMapSweepAfterRunInput): Promise<void> {
  const updated = await sweepNavMapEntries(input.page, input.navMap, {
    excludeEntry: input.usedEntry,
    onBeforeNavigate: input.onBeforeNavigate,
    onBeforeAction: input.onBeforeAction,
  });
  for (const entry of updated) {
    await input.navMapRepo.updateEntryVerification(input.navMap.baseUrl, entry.role, entry.label, {
      isStale: entry.isStale,
      lastVerifiedAt: entry.lastVerifiedAt,
      lastRelabeledAt: entry.lastRelabeledAt,
      pageStructure: entry.pageStructure,
    });
  }
}

async function runFailed(run: Run, deps: ExplorerRunLifecycleDeps, error: unknown): Promise<void> {
  try {
    await deps.runRepo.updateStatus(run.id, {
      status: "FAILED",
      finishedAt: new Date(),
      error: error instanceof Error ? error.message : String(error),
    });
  } catch (updateError) {
    console.error("explorerRunLifecycle: failed to persist FAILED status for run", run.id, updateError);
  }
}

async function executeExplorerRun(run: Run, input: StartExplorerRunInput, deps: ExplorerRunLifecycleDeps): Promise<void> {
  const registryEntry: CancellationEntry = { cancelRequested: false };
  explorerCancellationRegistry.set(run.id, registryEntry);
  try {
    await deps.runRepo.updateStatus(run.id, { status: "RUNNING" });

    assertAllowedUrl(run.targetBaseUrl, deps.allowedDomains);
    assertNotProductionUrl(run.targetBaseUrl, deps.productionUrlPatterns);
    if (deps.loginCreds) {
      assertAllowedUrl(deps.loginCreds.loginUrl, deps.allowedDomains);
      assertNotProductionUrl(deps.loginCreds.loginUrl, deps.productionUrlPatterns);
    }

    if (registryEntry.cancelRequested) {
      return;
    } // cancelled while PENDING — CANCELLED already written by cancelExplorerRun()

    const browser = await chromium.launch();
    if (registryEntry.cancelRequested) {
      await browser.close();
      return; // cancelled during launch — CANCELLED already written by cancelExplorerRun()
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

      if (deps.loginCreds) {
        await login(page, deps.loginCreds, onBeforeNavigate);
      } else {
        onBeforeNavigate(run.targetBaseUrl);
        await page.goto(run.targetBaseUrl);
      }

      const { clientFactory: trackedJudgeClientFactory, totals } = trackClientUsage(deps.judgeClientFactory);
      const navMap = (await deps.navMapRepo?.getByBaseUrl(run.targetBaseUrl)) ?? undefined;
      const navMapRepo = deps.navMapRepo;

      const located = await locateSection(page, input.sectionDescription, {
        onBeforeNavigate,
        onBeforeAction: deps.onBeforeAction,
        llmClientFactory: trackedJudgeClientFactory,
        navMap,
        onNavMapEntryVerified: navMapRepo
          ? (entry) =>
              navMapRepo.updateEntryVerification(run.targetBaseUrl, entry.role, entry.label, {
                isStale: false,
                lastVerifiedAt: new Date(),
              })
          : undefined,
        onNavMapEntryStale: navMapRepo
          ? (entry) => navMapRepo.updateEntryVerification(run.targetBaseUrl, entry.role, entry.label, { isStale: true })
          : undefined,
        onNavMapEntryRelabeled: navMapRepo
          ? (entry, newLabel) =>
              navMapRepo.updateEntryVerification(run.targetBaseUrl, entry.role, entry.label, {
                isStale: false,
                label: newLabel,
                lastVerifiedAt: new Date(),
                lastRelabeledAt: new Date(),
              })
          : undefined,
      });
      if (!located) {
        throw new Error(`section "${input.sectionDescription}" not found in navigation`);
      }

      const testRun = await runExplorerTestRun(
        { page, featureId: input.featureId, runId: run.id, runStartedAt: run.startedAt },
        { ...deps, judgeClientFactory: trackedJudgeClientFactory },
      );

      await deps.runRepo.updateStatus(run.id, {
        status: "COMPLETED",
        finishedAt: new Date(),
        stepsUsed: testRun.checkOutcomes.length,
        llmCallsUsed: totals.llmCallsUsed,
        costUsd: totals.costUsd,
      });

      if (navMapRepo && navMap) {
        const usedEntry = located.matchSource === "map" ? navMap.entries.find((entry) => entry.label === located.matchedLabel) : undefined;
        try {
          await sweepAndPersistNavMap({ page, navMap, navMapRepo, usedEntry, onBeforeNavigate, onBeforeAction: deps.onBeforeAction });
        } catch (error) {
          console.error("navMap sweep failed (non-fatal, run already completed successfully)", error);
        }
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    if (registryEntry.cancelRequested) {
      return;
    } // CANCELLED already written by cancelExplorerRun(), not a real failure
    await runFailed(run, deps, error);
  } finally {
    explorerCancellationRegistry.delete(run.id);
  }
}
