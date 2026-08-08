import { installNavigationGuard, type ActionDescriptor } from "@silly-rabbit/driver";
import type { AnthropicLike } from "@silly-rabbit/engine";
import {
  buildCheckExecutionErrorResult,
  buildRunContext,
  buildTestPlan,
  executeBoundaryCheck,
  executeHappyPathCheck,
  refreshLearningConfirmations,
  researchSection,
} from "@silly-rabbit/explorer";
import { TestRunSchema, type CheckOutcome, type Finding, type TestRun } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import type { FindingRepo } from "./repos/findingRepo.js";
import type { LearningRepo } from "./repos/learningRepo.js";
import { buildNavigationAllowedCheck } from "./safety.js";
import { enforceScreenshotStorageCap } from "./screenshotRetention.js";
import type { TestRunRepo } from "./repos/testRunRepo.js";

export interface ExplorerOrchestratorDeps {
  testRunRepo: TestRunRepo;
  learningRepo: LearningRepo;
  findingRepo: FindingRepo;
  judgeClientFactory: () => AnthropicLike;
  allowedDomains: string[];
  productionUrlPatterns: RegExp[];
  screenshotDirectory: string;
  screenshotStorageCapBytes: number;
  testPlanModel?: string;
  maxHypotheses?: number;
  outcomeJudgeModel?: string;
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
  onBeforeRollbackDelete?: (action: ActionDescriptor, verifiedMarkerMatch: boolean) => Promise<void> | void;
}

export interface RunExplorerTestRunInput {
  page: Page;
  featureId: string;
  runId: string;
  runStartedAt: Date;
}

export async function runExplorerTestRun(input: RunExplorerTestRunInput, deps: ExplorerOrchestratorDeps): Promise<TestRun> {
  const { page, featureId, runId } = input;
  const startedAt = new Date();

  await installNavigationGuard(page, {
    isNavigationAllowed: buildNavigationAllowedCheck(deps.allowedDomains, deps.productionUrlPatterns),
  });

  const research = await researchSection(page, featureId);
  const { activeLearnings } = await buildRunContext(featureId, deps.learningRepo);
  const testPlan = await buildTestPlan(research, activeLearnings, {
    clientFactory: deps.judgeClientFactory,
    model: deps.testPlanModel,
    maxHypotheses: deps.maxHypotheses,
  });

  const testRunId = randomUUID();
  await deps.testRunRepo.create(
    TestRunSchema.parse({
      id: testRunId,
      featureId,
      runId,
      research,
      testPlan,
      checkOutcomes: [],
      findingIds: [],
      startedAt,
      status: "RUNNING",
    }),
  );

  const checkOutcomes: CheckOutcome[] = [];
  const findings: Finding[] = [];

  const recordFinding = async (finding: Finding, screenshotBuffer?: Buffer, beforeScreenshotBuffer?: Buffer): Promise<void> => {
    const [existing] = await deps.findingRepo.findByDedupKeys([finding.dedupKey]);
    if (existing?.status === "DISMISSED") {
      findings.push(existing);
      return;
    }

    let findingToPersist = finding;
    if (screenshotBuffer) {
      await mkdir(deps.screenshotDirectory, { recursive: true });
      const screenshotPath = join(deps.screenshotDirectory, `${finding.id}.png`);
      await writeFile(screenshotPath, screenshotBuffer);
      await enforceScreenshotStorageCap(deps.screenshotDirectory, deps.screenshotStorageCapBytes);
      findingToPersist = { ...findingToPersist, screenshotPath };
    }
    if (beforeScreenshotBuffer) {
      await mkdir(deps.screenshotDirectory, { recursive: true });
      const beforeScreenshotPath = join(deps.screenshotDirectory, `before-${finding.id}.png`);
      await writeFile(beforeScreenshotPath, beforeScreenshotBuffer);
      await enforceScreenshotStorageCap(deps.screenshotDirectory, deps.screenshotStorageCapBytes);
      findingToPersist = { ...findingToPersist, beforeScreenshotPath };
    }

    findings.push(findingToPersist);
    await deps.findingRepo.upsert(findingToPersist);
  };

  const persistProgress = async (): Promise<void> => {
    await deps.testRunRepo.update(testRunId, {
      checkOutcomes: [...checkOutcomes],
      findingIds: findings.map((finding) => finding.id),
    });
  };

  for (const hypothesis of testPlan) {
    try {
      const happyResult = await executeHappyPathCheck({
        page,
        research,
        hypothesisId: hypothesis.id,
        check: hypothesis.happyPathCheck,
        runId,
        judge: { clientFactory: deps.judgeClientFactory, model: deps.outcomeJudgeModel },
        onBeforeNavigate: deps.onBeforeNavigate,
        onBeforeAction: deps.onBeforeAction,
      });
      checkOutcomes.push(happyResult.checkOutcome);
      if (happyResult.finding) {
        await recordFinding(happyResult.finding, happyResult.screenshotBuffer, happyResult.beforeScreenshotBuffer);
      }
    } catch (error) {
      const errorResult = buildCheckExecutionErrorResult({
        runId,
        hypothesisId: hypothesis.id,
        checkKind: "happy",
        check: hypothesis.happyPathCheck,
        research,
        error,
      });
      checkOutcomes.push(errorResult.checkOutcome);
      await recordFinding(errorResult.finding);
    }
    await persistProgress();

    try {
      const boundaryResult = await executeBoundaryCheck({
        page,
        research,
        hypothesisId: hypothesis.id,
        check: hypothesis.boundaryCheck,
        runId,
        runStartedAt: input.runStartedAt,
        judge: { clientFactory: deps.judgeClientFactory, model: deps.outcomeJudgeModel },
        onBeforeNavigate: deps.onBeforeNavigate,
        onBeforeAction: deps.onBeforeAction,
        onBeforeRollbackDelete: deps.onBeforeRollbackDelete,
      });
      checkOutcomes.push(boundaryResult.checkOutcome);
      for (const [index, finding] of boundaryResult.findings.entries()) {
        const screenshotBuffer = index === 0 ? boundaryResult.checkFindingScreenshotBuffer : undefined;
        const beforeScreenshotBuffer = index === 0 ? boundaryResult.checkFindingBeforeScreenshotBuffer : undefined;
        await recordFinding(finding, screenshotBuffer, beforeScreenshotBuffer);
      }
    } catch (error) {
      const errorResult = buildCheckExecutionErrorResult({
        runId,
        hypothesisId: hypothesis.id,
        checkKind: "boundary",
        check: hypothesis.boundaryCheck,
        category: hypothesis.boundaryCheck.category,
        research,
        error,
      });
      checkOutcomes.push(errorResult.checkOutcome);
      await recordFinding(errorResult.finding);
    }
    await persistProgress();
  }

  await deps.testRunRepo.update(testRunId, {
    checkOutcomes,
    findingIds: findings.map((finding) => finding.id),
    status: "COMPLETED",
    finishedAt: new Date(),
  });

  const testRun = await deps.testRunRepo.get(testRunId);
  if (!testRun) throw new Error(`testRun ${testRunId} vanished after being persisted — this should be unreachable`);

  await refreshLearningConfirmations(testRun, activeLearnings, deps.learningRepo);

  return testRun;
}
