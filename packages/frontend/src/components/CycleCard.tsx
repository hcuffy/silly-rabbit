import type { Cycle } from "@silly-rabbit/shared";
import { Link } from "react-router";
import { useCycleStats } from "../lib/cycleQueries.js";

interface CycleCardProps {
  cycle: Cycle;
  isActive: boolean;
  onArchive: () => void;
  onActivate: () => void;
  isArchiving: boolean;
  isActivating: boolean;
}

export function CycleCard(props: CycleCardProps) {
  const { cycle, isActive, onArchive, onActivate, isArchiving, isActivating } = props;
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
          {stats.runCount} run(s) · {stats.replayRunCount} replay run(s) · {stats.newCount} new · {stats.suppressedCount} suppressed
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
            <button type="button" className="button button--secondary" disabled={isActivating} onClick={onActivate}>
              Set active
            </button>
          )}
          {!cycle.isDefault && (
            <button type="button" className="button button--destructive" disabled={isArchiving} onClick={onArchive}>
              Archive
            </button>
          )}
        </div>
      )}
    </div>
  );
}
