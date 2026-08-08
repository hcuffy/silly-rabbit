import { useState, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { RunId } from "../components/RunId.js";
import { StatusIcon } from "../components/StatusIcon.js";
import { groupRunsByDay } from "../lib/dateGrouping.js";
import { formatTime } from "../lib/formatDateTime.js";
import { useRunsList } from "../lib/queries.js";
import { computeRunNumber } from "../lib/runNumbering.js";

const PAGE_SIZE = 25;

function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, onSelect: () => void): void {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelect();
}

export function RunHistory() {
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  const [searchParameters] = useSearchParams();
  const cycleId = searchParameters.get("cycleId") ?? undefined;
  const { data, isPending, isError, error } = useRunsList({ limit: PAGE_SIZE, offset, cycleId });

  if (isPending) return <p>Loading run history…</p>;
  if (isError)
    return (
      <p className="form-error" role="alert">
        Failed to load runs: {error.message}
      </p>
    );
  if (data.total === 0) return <p>No runs yet — start one above.</p>;

  const dayGroups = groupRunsByDay(data.runs);
  const pageStart = offset + 1;
  const pageEnd = offset + data.runs.length;
  const runNumberById = new Map(data.runs.map((run, index) => [run.id, computeRunNumber(offset, index)]));

  return (
    <>
      <table className="run-history">
        <thead>
          <tr>
            <th>#</th>
            <th>Run</th>
            <th>Charter</th>
            <th>Status</th>
            <th>Triggered by</th>
            <th>Time</th>
            <th>Steps</th>
            <th>LLM calls</th>
            <th>Cost</th>
          </tr>
        </thead>
        {dayGroups.map((group) => (
          <tbody key={group.label}>
            <tr className="run-history__day-header">
              <td colSpan={9}>{group.label}</td>
            </tr>
            {group.runs.map((run) => {
              const runNumber = runNumberById.get(run.id);
              const goToDetail = () => void navigate(`/runs/${run.id}`, { state: { runNumber } });
              return (
                <tr
                  key={run.id}
                  onClick={goToDetail}
                  onKeyDown={(event) => handleRowKeyDown(event, goToDetail)}
                  tabIndex={0}
                >
                  <td className="run-history__number">{runNumber}</td>
                  <td>
                    <RunId id={run.id} />
                  </td>
                  <td>{run.charter}</td>
                  <td>
                    <StatusIcon status={run.status} />
                  </td>
                  <td>{run.triggeredBy ?? "unknown"}</td>
                  <td>{formatTime(run.startedAt)}</td>
                  <td>{run.stepsUsed}</td>
                  <td>{run.llmCallsUsed}</td>
                  <td>${run.costUsd.toFixed(4)}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
      <div className="run-history__pagination">
        <button
          type="button"
          className="button button--secondary"
          onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
          disabled={offset === 0}
        >
          Previous
        </button>
        <span>
          {pageStart}–{pageEnd} of {data.total}
        </span>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => setOffset(offset + PAGE_SIZE)}
          disabled={pageEnd >= data.total}
        >
          Next
        </button>
      </div>
    </>
  );
}
