import { computeDedupKey, deriveFingerprint, deriveScreenId, DEFAULT_CONFIDENCE_THRESHOLD, type FindingDraft } from "@silly-rabbit/engine";
import { attachCapture, captureObservation, type ActionDescriptor } from "@silly-rabbit/driver";
import type { BoundaryCheck, CheckOutcome, Finding, ResearchInventory } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { buildDedupSignature } from "./dedupSignature.js";
import {
  describeExcludedAction,
  findElementByAccessibleName,
  fillElement,
  performResolvedActionClick,
  resolveActionButton,
} from "./happyPathExecutor.js";
import { generateMarker, injectMarker, selectFreeTextField } from "./marker.js";
import { judgeOutcome, type OutcomeJudgeOptions } from "./outcomeJudge.js";
import { rollback, type RollbackLocator, type RollbackOptions, type RollbackResult } from "./rollback.js";

export interface BoundaryCheckInput {
  page: Page;
  research: ResearchInventory;
  hypothesisId: string;
  check: BoundaryCheck;
  runId: string;
  runStartedAt: Date;
  judge: OutcomeJudgeOptions;
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
  onBeforeRollbackDelete?: RollbackOptions["onBeforeRollbackDelete"];
}

export interface BoundaryCheckResult {
  checkOutcome: CheckOutcome;
  findings: Finding[];
  rollback: RollbackResult | undefined;
  checkFindingScreenshotBuffer?: Buffer;
  checkFindingBeforeScreenshotBuffer?: Buffer;
}

function buildSkippedResult(input: BoundaryCheckInput, reasoning: string, screenId: string): BoundaryCheckResult {
  const maskedSignature = buildDedupSignature(input.check.description, input.check.category);
  const draft: FindingDraft = { screenId, type: "BEHAVIOR_CHECK_FAILED", evidence: {}, maskedSignature };
  const now = new Date();
  const finding: Finding = {
    id: randomUUID(),
    runId: input.runId,
    screenId,
    featureId: input.research.featureId,
    type: "BEHAVIOR_CHECK_FAILED",
    verdict: "NEEDS_HUMAN",
    severity: "LOW",
    reasoning,
    confidence: 0,
    evidence: {},
    dedupKey: computeDedupKey(draft),
    status: "NEW",
    createdAt: now,
    updatedAt: now,
  };
  return {
    checkOutcome: { hypothesisId: input.hypothesisId, check: "boundary", result: "skipped" },
    findings: [finding],
    rollback: undefined,
  };
}

function describeRollbackLocator(locator: RollbackLocator): string {
  if (locator.kind === "marker") {
    return `marker: ${locator.marker}`;
  }
  return `inputValues: ${JSON.stringify(locator.inputValues)}, window: ${locator.window.from.toISOString()}–${locator.window.to.toISOString()}`;
}

interface RollbackFailureFindingInput {
  runId: string;
  screenId: string;
  featureId: string;
  check: BoundaryCheck;
  locator: RollbackLocator;
  reason: string;
}

function buildRollbackFailureFinding(input: RollbackFailureFindingInput): Finding {
  const maskedSignature = `rollback-failed:${input.reason}:${input.check.description}`;
  const draft: FindingDraft = { screenId: input.screenId, type: "OTHER", evidence: {}, maskedSignature };
  const now = new Date();
  return {
    id: randomUUID(),
    runId: input.runId,
    screenId: input.screenId,
    featureId: input.featureId,
    type: "OTHER",
    verdict: "NEEDS_HUMAN",
    severity: "WARNING",
    reasoning:
      `Rollback failed (${input.reason}) for boundary check "${input.check.description}". ` +
      `${describeRollbackLocator(input.locator)}. Manual cleanup required.`,
    confidence: 1,
    evidence: {},
    dedupKey: computeDedupKey(draft),
    status: "NEW",
    createdAt: now,
    updatedAt: now,
  };
}

export async function executeBoundaryCheck(input: BoundaryCheckInput): Promise<BoundaryCheckResult> {
  const { page, research, check } = input;
  const preflightScreenId = deriveScreenId({ url: page.url(), ariaSnapshot: research.ariaSnapshotMasked }).screenId;

  for (const fieldName of Object.keys(check.inputValues ?? {})) {
    if (!findElementByAccessibleName(research, fieldName)) {
      const reasoning = `Boundary check names a field not present in the research inventory: "${fieldName}".`;
      return buildSkippedResult(input, reasoning, preflightScreenId);
    }
  }

  const buttonResolution = resolveActionButton(research, check);
  if (buttonResolution.status === "unresolved") {
    const reasoning = check.targetElement
      ? `Boundary check's targetElement "${check.targetElement}" does not match any button in the research inventory.`
      : "Boundary check's action could not be matched to a button in the research inventory by description, " +
        "and no targetElement was given — refusing to guess which button to click.";
    return buildSkippedResult(input, reasoning, preflightScreenId);
  }
  if (buttonResolution.status === "excluded") {
    const reasoning = describeExcludedAction("Boundary", buttonResolution.element, buttonResolution.reason);
    return buildSkippedResult(input, reasoning, preflightScreenId);
  }

  const originalInputValues = check.inputValues ?? {};
  const isMutatingCheck = check.action === "submit";
  const markerField = isMutatingCheck ? selectFreeTextField(originalInputValues, research) : undefined;
  let locator: RollbackLocator | undefined;
  let filledValues: Record<string, string>;
  if (markerField) {
    const marker = generateMarker();
    filledValues = injectMarker(originalInputValues, markerField, marker);
    locator = { kind: "marker", marker };
  } else {
    filledValues = originalInputValues;
    locator = isMutatingCheck
      ? { kind: "fieldMatch", inputValues: originalInputValues, window: { from: input.runStartedAt, to: new Date() } }
      : undefined;
  }

  const handle = attachCapture(page);
  handle.reset();

  for (const [fieldName, value] of Object.entries(filledValues)) {
    const element = findElementByAccessibleName(research, fieldName);
    if (element) {
      await fillElement(page, element, value);
    }
  }

  const beforeScreenshotBuffer = await page.screenshot().catch(() => undefined);

  await performResolvedActionClick(page, buttonResolution, {
    onBeforeNavigate: input.onBeforeNavigate,
    onBeforeAction: input.onBeforeAction,
  });

  await page.waitForLoadState("networkidle");
  const observation = await captureObservation(page, handle);
  const { screenId } = deriveScreenId({
    url: observation.url,
    ariaSnapshot: observation.ariaSnapshot,
    documentTitle: observation.documentTitle,
  });
  const { ariaSnapshotMasked } = deriveFingerprint(observation.ariaSnapshot);

  const judged = await judgeOutcome(
    {
      description: check.description,
      expectedOutcome: check.expectedOutcome,
      ariaSnapshotMasked,
      consoleErrors: observation.consoleErrors,
    },
    input.judge,
  );

  const confident = judged.confidence >= DEFAULT_CONFIDENCE_THRESHOLD;
  const findings: Finding[] = [];
  let checkOutcome: CheckOutcome;

  if (judged.passed && confident) {
    checkOutcome = { hypothesisId: input.hypothesisId, check: "boundary", result: "passed" };
  } else {
    const now = new Date();
    const evidence: Finding["evidence"] = {
      ariaSnapshot: ariaSnapshotMasked,
      ...(observation.consoleErrors ? { consoleMessages: observation.consoleErrors } : {}),
      ...(observation.httpErrors ? { networkErrors: observation.httpErrors } : {}),
    };
    const maskedSignature = buildDedupSignature(check.description, check.category);
    const draft: FindingDraft = { screenId, type: "BEHAVIOR_CHECK_FAILED", evidence, maskedSignature };
    findings.push({
      id: randomUUID(),
      runId: input.runId,
      screenId,
      featureId: research.featureId,
      type: "BEHAVIOR_CHECK_FAILED",
      verdict: confident ? "REGRESSION" : "NEEDS_HUMAN",
      severity: "MEDIUM",
      reasoning: judged.reasoning,
      confidence: judged.confidence,
      evidence,
      dedupKey: computeDedupKey(draft),
      status: "NEW",
      createdAt: now,
      updatedAt: now,
    });
    checkOutcome = { hypothesisId: input.hypothesisId, check: "boundary", result: "failed" };
  }

  let rollbackResult: RollbackResult | undefined;
  if (locator) {
    rollbackResult = await rollback(page, locator, { onBeforeRollbackDelete: input.onBeforeRollbackDelete });
    if (rollbackResult.status === "FAILED") {
      findings.push(
        buildRollbackFailureFinding({
          runId: input.runId,
          screenId,
          featureId: research.featureId,
          check,
          locator,
          reason: rollbackResult.reason,
        }),
      );
    }
  }

  return {
    checkOutcome,
    findings,
    rollback: rollbackResult,
    checkFindingScreenshotBuffer: observation.screenshotBuffer,
    checkFindingBeforeScreenshotBuffer: beforeScreenshotBuffer,
  };
}
