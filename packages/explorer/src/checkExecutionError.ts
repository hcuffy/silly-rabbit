import { computeDedupKey, deriveScreenId } from "@silly-rabbit/engine";
import type { BoundaryCheck, Check, CheckOutcome, Finding, ResearchInventory } from "@silly-rabbit/shared";
import { randomUUID } from "node:crypto";
import { buildDedupSignature } from "./dedupSignature.js";

const TIMEOUT_MESSAGE_PATTERN = /timeout/i;

export function classifyCheckExecutionError(error: unknown): "failed" | "timed_out" {
  const message = error instanceof Error ? error.message : String(error);
  return TIMEOUT_MESSAGE_PATTERN.test(message) ? "timed_out" : "failed";
}

export interface CheckExecutionErrorInput {
  runId: string;
  hypothesisId: string;
  checkKind: "happy" | "boundary";
  check: Check | BoundaryCheck;
  category?: string;
  research: ResearchInventory;
  error: unknown;
}

export function buildCheckExecutionErrorResult(input: CheckExecutionErrorInput): {
  checkOutcome: CheckOutcome;
  finding: Finding;
} {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const result = classifyCheckExecutionError(input.error);
  const { screenId } = deriveScreenId({ url: input.research.sectionUrl, ariaSnapshot: input.research.ariaSnapshotMasked });
  const maskedSignature = buildDedupSignature(input.check.description, input.category);
  const dedupKey = computeDedupKey({ screenId, type: "BEHAVIOR_CHECK_FAILED", evidence: {}, maskedSignature });
  const now = new Date();

  const checkLabel = input.checkKind === "happy" ? "Happy-path" : "Boundary";
  const finding: Finding = {
    id: randomUUID(),
    runId: input.runId,
    screenId,
    featureId: input.research.featureId,
    type: "BEHAVIOR_CHECK_FAILED",
    verdict: "NEEDS_HUMAN",
    severity: "LOW",
    reasoning: `${checkLabel} check "${input.check.description}" did not complete: ${message}`,
    confidence: 0,
    evidence: {},
    dedupKey,
    status: "NEW",
    createdAt: now,
    updatedAt: now,
  };

  return {
    checkOutcome: { hypothesisId: input.hypothesisId, check: input.checkKind, result },
    finding,
  };
}
