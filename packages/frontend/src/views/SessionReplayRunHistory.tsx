import { useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { StatusIcon } from "../components/StatusIcon.js";
import { groupRunsByDay } from "../lib/dateGrouping.js";
import { formatTime } from "../lib/formatDateTime.js";
import { useSessionReplayRunsList } from "../lib/queries.js";

const PAGE_SIZE = 25;

function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, onSelect: () => void): void {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelect();
}

export function SessionReplayRunHistory() {
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  const [searchParameters] = useSearchParams();
  const cycleId = searchParameters.get("cycleId") ?? undefined;
  const { data, isPending, isError, error } = useSessionReplayRunsList({ limit: PAGE_SIZE, offset, cycleId });

  if (isPending) return <p>Loading session-replay run history…</p>;
  if (isError)
    return (
      <p className="form-error" role="alert">
        Failed to load session-replay runs: {error.message}
      </p>
    );
  if (data.total === 0) return <p>No session-replay runs yet.</p>;

  const dayGroups = groupRunsByDay(data.sessionReplayRuns);
  const pageStart = offset + 1;
  const pageEnd = offset + data.sessionReplayRuns.length;

  return (
    <>
      <table className="run-history">
        <thead>
          <tr>
            <th>Session</th>
            <th>Status</th>
            <th>Mode</th>
            <th>Time</th>
            <th>Steps</th>
          </tr>
        </thead>
        {dayGroups.map((group) => (
          <tbody key={group.label}>
            <tr className="run-history__day-header">
              <td colSpan={5}>{group.label}</td>
            </tr>
            {group.runs.map((run) => {
              const goToDetail = () => void navigate(`/session-replay/${run.id}`);
              return (
                <tr key={run.id} onClick={goToDetail} onKeyDown={(event) => handleRowKeyDown(event, goToDetail)} tabIndex={0}>
                  <td className="run-history__number">{run.sessionId.slice(0, 8)}</td>
                  <td>
                    <StatusIcon status={run.status} />
                  </td>
                  <td>{run.replayMode}</td>
                  <td>{formatTime(run.startedAt)}</td>
                  <td>
                    {run.summary.stepsExecuted} executed · {run.summary.stepsDrifted} drifted · {run.summary.stepsErrored} errored
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
      <div className="run-history__pagination">
        <button type="button" onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))} disabled={offset === 0}>
          Previous
        </button>
        <span>
          {pageStart}–{pageEnd} of {data.total}
        </span>
        <button type="button" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={pageEnd >= data.total}>
          Next
        </button>
      </div>
    </>
  );
}
