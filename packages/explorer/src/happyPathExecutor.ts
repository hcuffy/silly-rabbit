import { computeDedupKey, deriveFingerprint, deriveScreenId, DEFAULT_CONFIDENCE_THRESHOLD, type FindingDraft } from "@silly-rabbit/engine";
import { attachCapture, captureObservation, type ActionDescriptor } from "@silly-rabbit/driver";
import type { Check, CheckOutcome, Finding, ResearchInventory, SectionElement } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { buildDedupSignature } from "./dedupSignature.js";
import { judgeOutcome, type OutcomeJudgeOptions } from "./outcomeJudge.js";

export type PlaywrightRole = Parameters<Page["getByRole"]>[0];

export interface ActionClickCallbacks {
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
}

export interface HappyPathCheckInput {
  page: Page;
  research: ResearchInventory;
  hypothesisId: string;
  check: Check;
  runId: string;
  judge: OutcomeJudgeOptions;
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
}

export interface HappyPathCheckResult {
  checkOutcome: CheckOutcome;
  finding: Finding | undefined;
  screenshotBuffer?: Buffer;
  beforeScreenshotBuffer?: Buffer;
}

export type ExcludedActionReason = "read-only-export" | "file-upload";

export type ActionButtonResolution =
  | { status: "found"; element: SectionElement }
  | { status: "not-needed" }
  | { status: "unresolved" }
  | { status: "excluded"; element: SectionElement; reason: ExcludedActionReason };

const EXCLUDED_READ_ONLY_ACTION_PATTERN = /export|download|print/i;
const EXCLUDED_FILE_UPLOAD_ACTION_PATTERN = /import|upload/i;

export function findElementByAccessibleName(research: ResearchInventory, accessibleName: string): SectionElement | undefined {
  return research.elements.find((element) => element.accessibleName === accessibleName);
}

export function describeExcludedAction(checkLabel: string, element: SectionElement, reason: ExcludedActionReason): string {
  if (reason === "file-upload") {
    return (
      `${checkLabel} check's target button "${element.accessibleName}" is a file-upload action — this framework ` +
      "has no file-picker handling, refusing to execute rather than risk an unbounded hang."
    );
  }
  return (
    `${checkLabel} check's target button "${element.accessibleName}" is export/download/print-shaped — outside ` +
    "the CRUD surface this feature tests, refusing to execute regardless of what the test-plan generated."
  );
}

function resolveFoundButton(element: SectionElement): ActionButtonResolution {
  if (EXCLUDED_READ_ONLY_ACTION_PATTERN.test(element.accessibleName)) {
    return { status: "excluded", element, reason: "read-only-export" };
  }
  if (EXCLUDED_FILE_UPLOAD_ACTION_PATTERN.test(element.accessibleName)) {
    return { status: "excluded", element, reason: "file-upload" };
  }
  return { status: "found", element };
}

export function resolveActionButton(research: ResearchInventory, check: Check): ActionButtonResolution {
  const buttons = research.elements.filter((element) => element.kind === "button");
  if (buttons.length === 0) {
    return { status: "not-needed" };
  }

  if (check.targetElement) {
    const exact = buttons.find((button) => button.accessibleName === check.targetElement);
    return exact ? resolveFoundButton(exact) : { status: "unresolved" };
  }

  const lowerDescription = check.description.toLowerCase();
  const described = buttons.find((button) => lowerDescription.includes(button.accessibleName.toLowerCase()));
  return described ? resolveFoundButton(described) : { status: "unresolved" };
}

export async function fillElement(page: Page, element: SectionElement, value: string): Promise<void> {
  if (element.kind === "dropdown") {
    await page.getByRole(element.role as PlaywrightRole, { name: element.accessibleName }).click();
    await page.getByRole("option", { name: value }).click();
    return;
  }
  await page.getByRole(element.role as PlaywrightRole, { name: element.accessibleName }).fill(value);
}

async function resolveFormActionUrl(page: Page, buttonLocator: ReturnType<Page["getByRole"]>): Promise<string | undefined> {
  const formAction = await buttonLocator
    .evaluate((element) => (element as HTMLElement).closest("form")?.getAttribute("action") ?? undefined)
    .catch(() => undefined);
  return formAction ? new URL(formAction, page.url()).toString() : undefined;
}

export async function performResolvedActionClick(
  page: Page,
  buttonResolution: ActionButtonResolution,
  callbacks: ActionClickCallbacks = {},
): Promise<void> {
  if (buttonResolution.status !== "found") {
    return;
  }
  const actionButton = buttonResolution.element;
  const buttonLocator = page.getByRole(actionButton.role as PlaywrightRole, { name: actionButton.accessibleName });

  const formActionUrl = await resolveFormActionUrl(page, buttonLocator);
  if (formActionUrl) {
    await callbacks.onBeforeNavigate?.(formActionUrl);
  }

  const action: ActionDescriptor = { role: actionButton.role, accessibleName: actionButton.accessibleName };
  await callbacks.onBeforeAction?.(action);
  await buttonLocator.click();
}

function buildSkippedResult(input: HappyPathCheckInput, reasoning: string, screenId: string): HappyPathCheckResult {
  const maskedSignature = buildDedupSignature(input.check.description);
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
    checkOutcome: { hypothesisId: input.hypothesisId, check: "happy", result: "skipped" },
    finding,
  };
}

export async function executeHappyPathCheck(input: HappyPathCheckInput): Promise<HappyPathCheckResult> {
  const { page, research, check } = input;
  const preflightScreenId = deriveScreenId({ url: page.url(), ariaSnapshot: research.ariaSnapshotMasked }).screenId;

  for (const fieldName of Object.keys(check.inputValues ?? {})) {
    if (!findElementByAccessibleName(research, fieldName)) {
      const reasoning = `Happy-path check names a field not present in the research inventory: "${fieldName}".`;
      return buildSkippedResult(input, reasoning, preflightScreenId);
    }
  }

  const buttonResolution = resolveActionButton(research, check);
  if (buttonResolution.status === "unresolved") {
    const reasoning = check.targetElement
      ? `Happy-path check's targetElement "${check.targetElement}" does not match any button in the research inventory.`
      : "Happy-path check's action could not be matched to a button in the research inventory by description, " +
        "and no targetElement was given — refusing to guess which button to click.";
    return buildSkippedResult(input, reasoning, preflightScreenId);
  }
  if (buttonResolution.status === "excluded") {
    const reasoning = describeExcludedAction("Happy-path", buttonResolution.element, buttonResolution.reason);
    return buildSkippedResult(input, reasoning, preflightScreenId);
  }

  const handle = attachCapture(page);
  handle.reset();

  for (const [fieldName, value] of Object.entries(check.inputValues ?? {})) {
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
  if (judged.passed && confident) {
    return {
      checkOutcome: { hypothesisId: input.hypothesisId, check: "happy", result: "passed" },
      finding: undefined,
    };
  }

  const now = new Date();
  const evidence: Finding["evidence"] = {
    ariaSnapshot: ariaSnapshotMasked,
    ...(observation.consoleErrors ? { consoleMessages: observation.consoleErrors } : {}),
    ...(observation.httpErrors ? { networkErrors: observation.httpErrors } : {}),
  };
  const draft: FindingDraft = {
    screenId,
    type: "BEHAVIOR_CHECK_FAILED",
    evidence,
    maskedSignature: buildDedupSignature(check.description),
  };
  const finding: Finding = {
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
  };

  return {
    checkOutcome: { hypothesisId: input.hypothesisId, check: "happy", result: "failed" },
    finding,
    screenshotBuffer: observation.screenshotBuffer,
    beforeScreenshotBuffer,
  };
}
