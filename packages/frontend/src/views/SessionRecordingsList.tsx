import { useState } from "react";
import { useNavigate } from "react-router";
import { CycleSelect } from "../components/CycleSelect.js";
import { formatDateTime } from "../lib/formatDateTime.js";
import { getLastUsedCycleId, setLastUsedCycleId } from "../lib/lastUsedCycle.js";
import { useSessionRecordingsList, useTriggerSessionReplayRun } from "../lib/queries.js";

export function SessionRecordingsList() {
  const navigate = useNavigate();
  const { data, isPending, isError, error } = useSessionRecordingsList();
  const triggerMutation = useTriggerSessionReplayRun();
  const [cycleIdBySessionId, setCycleIdBySessionId] = useState<Record<string, string>>({});

  if (isPending) return <p>Loading session recordings…</p>;
  if (isError)
    return (
      <p className="form-error" role="alert">
        Failed to load session recordings: {error.message}
      </p>
    );
  if (data.length === 0) return <p>No recorded sessions yet.</p>;

  const onReplay = async (sessionId: string): Promise<void> => {
    const cycleId = cycleIdBySessionId[sessionId] || getLastUsedCycleId() || undefined;
    const result = await triggerMutation.mutateAsync({ sessionId, cycleId });
    if (cycleId) setLastUsedCycleId(cycleId);
    void navigate(`/session-replay/${result.runId}`);
  };

  return (
    <table className="run-history">
      <thead>
        <tr>
          <th>Session</th>
          <th>Target</th>
          <th>Recorded</th>
          <th>Cycle</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.map((recording) => (
          <tr key={recording.sessionId}>
            <td className="run-history__number">{recording.sessionId.slice(0, 8)}</td>
            <td>{recording.targetBaseUrl}</td>
            <td>{formatDateTime(recording.recordedAt)}</td>
            <td>
              <CycleSelect
                id={`cycle-${recording.sessionId}`}
                label={`Cycle for replay of session ${recording.sessionId.slice(0, 8)}`}
                hideLabel
                value={cycleIdBySessionId[recording.sessionId] ?? getLastUsedCycleId() ?? ""}
                onChange={(cycleId) =>
                  setCycleIdBySessionId((current) => ({ ...current, [recording.sessionId]: cycleId }))
                }
              />
            </td>
            <td>
              <button type="button" disabled={triggerMutation.isPending} onClick={() => void onReplay(recording.sessionId)}>
                Replay
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
