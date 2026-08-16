import { useParams } from "react-router";
import { SessionReplayDetail } from "./SessionReplayDetail.js";

export function SessionReplayDetailPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) {
    return null;
  }
  return <SessionReplayDetail runId={id} />;
}
