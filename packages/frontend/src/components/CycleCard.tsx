import type { Cycle } from "@silly-rabbit/shared";
import { Link } from "react-router";
import { useCycleStats } from "../lib/cycleQueries.js";

export function CycleCard({
  cycle,
  isActive,
  onArchive,
  onActivate,
  isArchiving,
  isActivating,
}: {
  cycle: Cycle;
  isActive: boolean;
  onArchive: () => void;
  onActivate: () => void;
  isArchiving: boolean;
  isActivating: boolean;
}) {
  const { data: stats } = useCycleStats(cycle.id);

  return (
    <div className={`cycle-card${cycle.status === "archived" ? " cycle-card--archived" : ""}`}>
      <h3>
        {cycle.name}
        {!cycle.isDefault && <span className="status-badge">{cycle.kind}</span>}
        {isActive && <span className="status-badge status-badge--active">Active</span>}
      </h3>
      {stats && (
        <p className="finding-stats">
          {stats.runCount} run(s) · {stats.replayRunCount} replay run(s) · {stats.newCount} new ·{" "}
          {stats.suppressedCount} suppressed
        </p>
      )}
      <p className="cycle-card__links">
        <Link to={`/runs?cycleId=${cycle.id}`}>View runs</Link>
        {" · "}
        <Link to={`/session-replay/runs?cycleId=${cycle.id}`}>View replay runs</Link>
      </p>
      {cycle.status === "active" && (
        <div className="cycle-card__actions">
          {!isActive && (
            <button type="button" disabled={isActivating} onClick={onActivate}>
              Set active
            </button>
          )}
          {!cycle.isDefault && (
            <button type="button" className="button-danger" disabled={isArchiving} onClick={onArchive}>
              Archive
            </button>
          )}
        </div>
      )}
    </div>
  );
}
