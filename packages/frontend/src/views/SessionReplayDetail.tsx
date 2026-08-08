import type { SessionRecordingStep } from "@silly-rabbit/shared";
import { FindingCard } from "../components/FindingCard.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { StatusIcon } from "../components/StatusIcon.js";
import { formatDateTime } from "../lib/formatDateTime.js";
import { useCycle } from "../lib/cycleQueries.js";
import { useSessionReplayRunDetail } from "../lib/queries.js";

function describeStep(step: SessionRecordingStep): string {
  const target = step.selectorStrategy === "role" ? step.accessibleName : step.cssSelector;
  if (step.action === "navigate") return `Navigate to ${step.value}`;
  if (step.action === "fill") return `Fill "${target}" with "${step.value}"`;
  return `Click "${target}"`;
}

export function SessionReplayDetail({ runId }: { runId: string }) {
  const runQuery = useSessionReplayRunDetail(runId);
  const cycleQuery = useCycle(runQuery.data?.cycleId);

  if (runQuery.isPending) return <p>Loading session-replay run…</p>;
  if (runQuery.isError)
    return (
      <p className="form-error" role="alert">
        Failed to load session-replay run: {runQuery.error.message}
      </p>
    );

  const run = runQuery.data;
  const headerText =
    run.cycleId && run.replayRunNumber !== undefined
      ? `${cycleQuery.data?.name ?? "…"}, Replay ${run.replayRunNumber}`
      : "Session replay detail";

  return (
    <section className="session-replay-detail">
      <h2>{headerText}</h2>
      <p>
        <StatusIcon status={run.status} /> <StatusBadge status={run.status} /> — mode: {run.replayMode}
      </p>
      <p>Session: {run.sessionId}</p>
      <p>
        Started: {formatDateTime(run.startedAt)}
        {run.completedAt && <> · Completed: {formatDateTime(run.completedAt)}</>}
      </p>
      <p className="finding-stats">
        {run.summary.stepsExecuted} executed · {run.summary.stepsDrifted} drifted · {run.summary.stepsErrored} errored
      </p>
      {run.error && (
        <p className="form-error" role="alert">
          Error: {run.error}
        </p>
      )}

      <h3>Steps</h3>
      <ol className="session-replay-detail__steps">
        {run.steps.map((step, index) => (
          <li key={index}>{describeStep(step)}</li>
        ))}
      </ol>

      <h3>Findings</h3>
      {run.findings.length === 0 && <p>No findings yet.</p>}
      {run.findings.length > 0 && (
        <ul className="finding-list">
          {run.findings.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
        </ul>
      )}
    </section>
  );
}
