import { computeFindingStats, computeJudgeAccuracy } from "@silly-rabbit/shared";
import { useEffect, useState } from "react";
import { FindingCard } from "../components/FindingCard.js";
import { RunId } from "../components/RunId.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { TestRunSection } from "../components/TestRunSection.js";
import type { FeedbackVerdict } from "../lib/apiClient.js";
import { formatDateTime } from "../lib/formatDateTime.js";
import { useCycle } from "../lib/cycleQueries.js";
import { useFindingFeedback, useRunDetail, useTargetStats } from "../lib/queries.js";
import { useTriageShortcuts } from "../lib/useTriageShortcuts.js";

export function RunDetail({ runId, runNumber }: { runId: string; runNumber?: number }) {
  const runQuery = useRunDetail(runId);
  const feedbackMutation = useFindingFeedback(runId);
  const [activeFindingIndex, setActiveFindingIndex] = useState(0);

  const findings = runQuery.data?.findings ?? [];
  const clampedActiveIndex = Math.min(activeFindingIndex, Math.max(findings.length - 1, 0));
  const findingStats = computeFindingStats(findings);
  const judgeAccuracy = computeJudgeAccuracy(findings);
  const hasScoredAccuracy = judgeAccuracy.agree + judgeAccuracy.disagree > 0;
  const targetStatsQuery = useTargetStats(runQuery.data?.targetBaseUrl);
  const targetStats = targetStatsQuery.data;
  const hasScoredTargetAccuracy = targetStats !== undefined && targetStats.agree + targetStats.disagree > 0;
  const cycleQuery = useCycle(runQuery.data?.cycleId);

  useEffect(() => {
    setActiveFindingIndex(0);
  }, [runId]);

  useTriageShortcuts({
    findings,
    activeIndex: clampedActiveIndex,
    onNavigate: setActiveFindingIndex,
    onFeedback: (findingId: string, verdict: FeedbackVerdict) => feedbackMutation.mutate({ findingId, verdict }),
  });

  if (runQuery.isPending) return <p>Loading run…</p>;
  if (runQuery.isError)
    return (
      <p className="form-error" role="alert">
        Failed to load run: {runQuery.error.message}
      </p>
    );

  const run = runQuery.data;
  const headerText =
    run.cycleId && run.cycleRunNumber !== undefined
      ? `${cycleQuery.data?.name ?? "…"}, Run ${run.cycleRunNumber}`
      : `Run detail${runNumber !== undefined ? ` #${runNumber}` : ""}`;

  return (
    <section className="run-detail">
      <h2>{headerText}</h2>
      <p>
        <RunId id={run.id} /> — <StatusBadge status={run.status} /> — {run.charter}
      </p>
      <p>Target: {run.targetBaseUrl}</p>
      {targetStats && (
        <p className="finding-stats">
          Across all runs against this target: {targetStats.newCount} new · {targetStats.suppressedCount} suppressed
          all-time
        </p>
      )}
      {hasScoredTargetAccuracy && targetStats && (
        <p className="finding-stats">
          Judge accuracy all-time (D8 findings with feedback only): {targetStats.agree} agree ·{" "}
          {targetStats.disagree} disagree
        </p>
      )}
      <p>
        Triggered by: {run.triggeredBy ?? "unknown"} · Started: {formatDateTime(run.startedAt)}
      </p>
      <p>
        Steps: {run.stepsUsed} · LLM calls: {run.llmCallsUsed} · Cost: ${run.costUsd.toFixed(4)}
      </p>
      {run.error && (
        <p className="form-error" role="alert">
          Error: {run.error}
        </p>
      )}

      {run.testRun && <TestRunSection testRun={run.testRun} />}

      <h3>Findings</h3>
      {findings.length === 0 && <p>No findings yet.</p>}
      {findings.length > 0 && (
        <>
          <p className="finding-stats">
            {findingStats.newCount} new · {findingStats.suppressedCount} suppressed
          </p>
          {hasScoredAccuracy && (
            <p className="finding-stats">
              Judge accuracy (D8 findings with feedback only): {judgeAccuracy.agree} agree ·{" "}
              {judgeAccuracy.disagree} disagree
            </p>
          )}
          <p className="triage-hint">
            Keyboard: <kbd>1</kbd> confirmed issue · <kbd>2</kbd> intended behavior (explorer findings only) ·{" "}
            <kbd>3</kbd> dismiss · <kbd>N</kbd>/<kbd>P</kbd> next/previous finding.
          </p>
          <ul className="finding-list">
            {findings.map((finding, index) => (
              <FindingCard key={finding.id} finding={finding} isActive={index === clampedActiveIndex} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
