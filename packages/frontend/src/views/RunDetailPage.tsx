import { useLocation, useParams } from "react-router";
import { RunDetail } from "./RunDetail.js";

interface RunDetailNavigationState {
  runNumber?: number;
}

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  if (!id) {
    return null;
  }

  const runNumber = (location.state as RunDetailNavigationState | null)?.runNumber;
  return <RunDetail runId={id} runNumber={runNumber} />;
}
