import { useNavigate } from "react-router";
import { NewExplorerRunForm } from "./NewExplorerRunForm.js";
import { NewRunForm } from "./NewRunForm.js";

export function HomePage() {
  const navigate = useNavigate();
  const onCreated = (runId: string): void => void navigate(`/runs/${runId}`);

  return (
    <div className="new-run-row">
      <NewRunForm onCreated={onCreated} />
      <NewExplorerRunForm onCreated={onCreated} />
    </div>
  );
}
