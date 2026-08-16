import { randomUUID } from "node:crypto";
import type { Baseline, Finding } from "@silly-rabbit/shared";
import { computeDedupKey } from "./dedup.js";
import { deriveFingerprint } from "./fingerprint.js";
import { runJudge, type JudgeRunOptions, type JudgeVerdict } from "./judge.js";
import { runOracle } from "./oracle.js";
import { deriveScreenId } from "./screenId.js";
import type { EngineLoopInput, EngineLoopOutput, FindingDraft } from "./types.js";

class BudgetTracker {
  llmCallsUsed = 0;
  costUsd = 0;

  constructor(
    private readonly maxLlmCalls: number,
    private readonly maxUsdPerRun: number,
  ) {}

  exhausted(): boolean {
    return this.llmCallsUsed >= this.maxLlmCalls || this.costUsd >= this.maxUsdPerRun;
  }

  record(llmCallsUsed: number, costUsd: number): void {
    this.llmCallsUsed += llmCallsUsed;
    this.costUsd += costUsd;
  }
}

interface BuildFindingContext {
  charter: string;
  baselineAriaSnapshotMasked: string;
  judge: JudgeRunOptions;
  budget: BudgetTracker;
}

async function judgeDivergence(
  draft: FindingDraft,
  context: BuildFindingContext,
): Promise<JudgeVerdict & { llmCallsUsed: number; costUsd: number; infraError?: string; escalatedToOpus: boolean }> {
  if (context.budget.exhausted()) {
    return {
      verdict: "NEEDS_HUMAN",
      severity: "MEDIUM",
      reasoning: "LLM budget cap reached for this run; not judged.",
      confidence: 0,
      llmCallsUsed: 0,
      costUsd: 0,
      escalatedToOpus: false,
    };
  }

  const result = await runJudge(
    {
      charter: context.charter,
      screenId: draft.screenId,
      baselineAriaSnapshotMasked: context.baselineAriaSnapshotMasked,
      currentAriaSnapshotMasked: draft.evidence.ariaSnapshot ?? "",
    },
    context.judge,
  );
  context.budget.record(result.llmCallsUsed, result.costUsd);
  return result;
}

interface BuildFindingInput {
  draft: FindingDraft;
  dedupKey: string;
  runId: string;
  now: Date;
  context: BuildFindingContext;
}

async function buildFinding({ draft, dedupKey, runId, now, context }: BuildFindingInput): Promise<Finding> {
  const isDivergence = draft.type === "STATE_DIVERGENCE";
  const judged = isDivergence ? await judgeDivergence(draft, context) : undefined;

  return {
    id: randomUUID(),
    runId,
    screenId: draft.screenId,
    type: draft.type,
    verdict: judged?.verdict,
    severity: judged?.severity,
    reasoning: judged?.reasoning,
    confidence: judged?.confidence,
    ...(judged?.infraError ? { explanation: judged.reasoning } : {}),
    escalatedToOpus: judged?.escalatedToOpus,
    evidence: draft.evidence,
    beforeScreenshotPath: draft.beforeScreenshotPath,
    dedupKey,
    status: "NEW",
    createdAt: now,
    updatedAt: now,
  };
}

export async function runEngineLoop(input: EngineLoopInput): Promise<EngineLoopOutput> {
  const now = new Date();
  const baselineByScreen = new Map(input.existingBaselines.map((b) => [b.screenId, b]));
  const findingByDedupKey = new Map(input.existingFindings.map((f) => [f.dedupKey, f]));
  const budget = new BudgetTracker(input.maxLlmCalls ?? Infinity, input.maxUsdPerRun ?? Infinity);

  const newBaselines: Baseline[] = [];
  const findings: Finding[] = [];
  const dedupKeysByScreen = new Map<string, Set<string>>();

  for (const observation of input.observations) {
    const { screenId } = deriveScreenId(observation);
    const { ariaSnapshotMasked, fingerprint } = deriveFingerprint(observation.ariaSnapshot);

    const drafts: FindingDraft[] = runOracle(observation, screenId);

    const existingBaseline = baselineByScreen.get(screenId);
    if (!existingBaseline) {
      const learned: Baseline = { screenId, fingerprint, ariaSnapshotMasked, capturedAt: now, runId: input.runId };
      newBaselines.push(learned);
      baselineByScreen.set(screenId, learned);
    } else if (existingBaseline.fingerprint !== fingerprint) {
      drafts.push({
        screenId,
        type: "STATE_DIVERGENCE",
        evidence: { ariaSnapshot: ariaSnapshotMasked, ariaSnapshotBefore: existingBaseline.ariaSnapshotMasked },
        maskedSignature: fingerprint,
        beforeScreenshotPath: existingBaseline.baselineScreenshotPath,
      });
    }

    const context: BuildFindingContext = {
      charter: input.charter,
      baselineAriaSnapshotMasked: existingBaseline?.ariaSnapshotMasked ?? "",
      judge: input.judge,
      budget,
    };

    const thisScreenDedupKeys = dedupKeysByScreen.get(screenId) ?? new Set<string>();
    dedupKeysByScreen.set(screenId, thisScreenDedupKeys);
    for (const draft of drafts) {
      const dedupKey = computeDedupKey(draft);
      thisScreenDedupKeys.add(dedupKey);

      const existing = findingByDedupKey.get(dedupKey);
      if (existing) {
        findings.push({ ...existing, status: "RECURRING", verdict: "KNOWN", runId: input.runId, updatedAt: now });
      } else {
        findings.push(await buildFinding({ draft, dedupKey, runId: input.runId, now, context }));
      }
    }
  }

  for (const [screenId, seenDedupKeys] of dedupKeysByScreen) {
    const openPrior = input.existingFindings.filter((f) => f.screenId === screenId && (f.status === "NEW" || f.status === "RECURRING"));
    for (const prior of openPrior) {
      if (!seenDedupKeys.has(prior.dedupKey)) {
        findings.push({ ...prior, status: "RESOLVED", runId: input.runId, updatedAt: now });
      }
    }
  }

  return { baselines: newBaselines, findings, llmCallsUsed: budget.llmCallsUsed, costUsd: budget.costUsd };
}
