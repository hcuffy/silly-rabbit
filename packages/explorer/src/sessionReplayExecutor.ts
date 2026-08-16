import {
  computeDedupKey,
  deriveFingerprint,
  deriveScreenId,
  runJudge,
  runOracle,
  type FindingDraft,
  type JudgeRunOptions,
} from "@silly-rabbit/engine";
import { attachCapture, captureObservation, type ActionDescriptor, type CaptureHandle } from "@silly-rabbit/driver";
import type { Baseline, Finding, SessionRecordingStep } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import type { PlaywrightRole } from "./happyPathExecutor.js";
import { escapeRegExp, normalizeLabelForLlmMatchComparison } from "./sectionLocateLlmFallback.js";

export interface SessionReplayStepInput {
  page: Page;
  step: SessionRecordingStep;
  runId: string;
  charter: string;
  judge: JudgeRunOptions;
  getBaseline: (screenId: string) => Promise<Baseline | undefined>;
  getExistingFinding: (dedupKey: string) => Promise<Finding | undefined>;
  onBeforeNavigate?: (url: string) => Promise<void> | void;
  onBeforeAction?: (action: ActionDescriptor) => Promise<void> | void;
}

export interface SessionReplayStepResult {
  status: "executed" | "drift" | "error";
  newBaseline?: Baseline;
  findings: Finding[];
}

function describeStepSelector(step: SessionRecordingStep): string {
  if (step.selectorStrategy === "role") {
    return `role=${step.role ?? "?"} name="${step.accessibleName ?? "?"}"`;
  }
  return `css=${step.cssSelector ?? "?"}`;
}

export function buildStepFailureFinding(input: SessionReplayStepInput, reason: string): Finding {
  const { screenId } = deriveScreenId({ url: input.page.url(), ariaSnapshot: "" });
  const maskedSignature = `session-replay-step-failed:${describeStepSelector(input.step)}`;
  const dedupKey = computeDedupKey({ screenId, type: "BEHAVIOR_CHECK_FAILED", evidence: {}, maskedSignature });
  const now = new Date();

  return {
    id: randomUUID(),
    runId: input.runId,
    screenId,
    type: "BEHAVIOR_CHECK_FAILED",
    origin: "session-replay",
    verdict: "NEEDS_HUMAN",
    severity: "LOW",
    reasoning: `Recorded step (${input.step.action}) could not be replayed: ${reason}`,
    confidence: 0,
    evidence: {},
    dedupKey,
    status: "NEW",
    createdAt: now,
    updatedAt: now,
  };
}

async function resolveReplayLocator(page: Page, step: SessionRecordingStep): Promise<Locator | undefined> {
  if (step.selectorStrategy === "role" && step.role && step.accessibleName) {
    const role = step.role as PlaywrightRole;
    const byName = page.getByRole(role, { name: step.accessibleName });
    if ((await byName.count()) > 0) {
      return byName;
    }

    const normalizedName = normalizeLabelForLlmMatchComparison(step.accessibleName);
    return page.getByRole(role).filter({ hasText: new RegExp(escapeRegExp(normalizedName), "i") });
  }
  if (step.selectorStrategy === "css" && step.cssSelector) {
    return page.locator(step.cssSelector);
  }
  return undefined;
}

async function performStepAction(input: SessionReplayStepInput): Promise<SessionReplayStepResult | undefined> {
  const { page, step } = input;

  if (step.action === "navigate") {
    if (!step.value) {
      return { status: "drift", findings: [buildStepFailureFinding(input, "recorded navigate step has no URL")] };
    }
    await input.onBeforeNavigate?.(step.value);
    await page.goto(step.value);
    return undefined;
  }

  const locator = await resolveReplayLocator(page, step);
  if (!locator) {
    return { status: "drift", findings: [buildStepFailureFinding(input, "recorded step has no usable selector information")] };
  }

  const count = await locator.count();
  if (count === 0) {
    return { status: "drift", findings: [buildStepFailureFinding(input, `selector no longer resolves (${describeStepSelector(step)})`)] };
  }
  if (count > 1) {
    return {
      status: "drift",
      findings: [buildStepFailureFinding(input, `selector resolves ambiguously, ${count} matches (${describeStepSelector(step)})`)],
    };
  }

  if (step.action === "click") {
    if (step.selectorStrategy !== "role" || !step.role || !step.accessibleName) {
      return {
        status: "drift",
        findings: [
          buildStepFailureFinding(
            input,
            `click step has no accessible role/name to check against the destructive-action guard — ` +
              `refusing to click blind (${describeStepSelector(step)})`,
          ),
        ],
      };
    }
    await input.onBeforeAction?.({ role: step.role, accessibleName: step.accessibleName });
    await locator.click();
  } else if (step.action === "fill" && step.value !== undefined) {
    await locator.fill(step.value);
  }

  return undefined;
}

async function captureAndCompare(input: SessionReplayStepInput, handle: CaptureHandle): Promise<SessionReplayStepResult> {
  const { page, runId, charter, judge } = input;
  const observation = await captureObservation(page, handle);
  const { screenId } = deriveScreenId({ url: observation.url, ariaSnapshot: observation.ariaSnapshot, documentTitle: observation.documentTitle });
  const { ariaSnapshotMasked, fingerprint } = deriveFingerprint(observation.ariaSnapshot);

  const drafts: FindingDraft[] = runOracle(observation, screenId);
  const existingBaseline = await input.getBaseline(screenId);

  let newBaseline: Baseline | undefined;
  if (!existingBaseline) {
    newBaseline = { screenId, fingerprint, ariaSnapshotMasked, capturedAt: new Date(), runId };
  } else if (existingBaseline.fingerprint !== fingerprint) {
    drafts.push({
      screenId,
      type: "STATE_DIVERGENCE",
      evidence: { ariaSnapshot: ariaSnapshotMasked, ariaSnapshotBefore: existingBaseline.ariaSnapshotMasked },
      maskedSignature: fingerprint,
    });
  }

  const now = new Date();
  const findings: Finding[] = [];
  for (const draft of drafts) {
    const dedupKey = computeDedupKey(draft);
    const existing = await input.getExistingFinding(dedupKey);
    if (existing && (existing.status === "NEW" || existing.status === "RECURRING")) {
      findings.push({ ...existing, status: "RECURRING", verdict: "KNOWN", runId, updatedAt: now, origin: "session-replay" });
      continue;
    }

    const isDivergence = draft.type === "STATE_DIVERGENCE";
    const judged = isDivergence
      ? await runJudge(
          {
            charter,
            screenId,
            baselineAriaSnapshotMasked: existingBaseline?.ariaSnapshotMasked ?? "",
            currentAriaSnapshotMasked: draft.evidence.ariaSnapshot ?? "",
          },
          judge,
        )
      : undefined;

    findings.push({
      id: randomUUID(),
      runId,
      screenId,
      type: draft.type,
      origin: "session-replay",
      verdict: judged?.verdict,
      severity: judged?.severity,
      reasoning: judged?.reasoning,
      confidence: judged?.confidence,
      ...(judged?.infraError ? { explanation: judged.reasoning } : {}),
      escalatedToOpus: judged?.escalatedToOpus,
      evidence: draft.evidence,
      dedupKey,
      status: "NEW",
      createdAt: now,
      updatedAt: now,
    });
  }

  return { status: "executed", newBaseline, findings };
}

export async function executeSessionReplayStep(input: SessionReplayStepInput): Promise<SessionReplayStepResult> {
  const handle = attachCapture(input.page);
  handle.reset();

  try {
    const driftOrError = await performStepAction(input);
    if (driftOrError) {
      return driftOrError;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", findings: [buildStepFailureFinding(input, `execution error: ${message}`)] };
  }

  await input.page.waitForLoadState("networkidle");
  return captureAndCompare(input, handle);
}
