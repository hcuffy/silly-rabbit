import { useState } from "react";
import { CycleCard } from "../components/CycleCard.js";
import { useActivateCycle, useActiveCycleId, useArchiveCycle, useCreateCycle, useCyclesList } from "../lib/cycleQueries.js";
import { CycleForm } from "./CycleForm.js";

export function CycleList() {
  const { data: cycles, isPending, isError, error } = useCyclesList();
  const { data: activeCycleId } = useActiveCycleId();
  const createMutation = useCreateCycle();
  const archiveMutation = useArchiveCycle();
  const activateMutation = useActivateCycle();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [rowError, setRowError] = useState<string | undefined>(undefined);

  if (isPending) return <p>Loading cycles…</p>;
  if (isError)
    return (
      <p className="form-error" role="alert">
        Failed to load cycles: {error.message}
      </p>
    );

  async function handleArchive(id: string): Promise<void> {
    if (!window.confirm("Archive this cycle? It stays viewable, but can no longer be picked for new runs.")) return;
    setRowError(undefined);
    try {
      await archiveMutation.mutateAsync(id);
    } catch (archiveError) {
      setRowError(archiveError instanceof Error ? archiveError.message : "Failed to archive cycle.");
    }
  }

  async function handleActivate(id: string): Promise<void> {
    setRowError(undefined);
    try {
      await activateMutation.mutateAsync(id);
    } catch (activateError) {
      setRowError(activateError instanceof Error ? activateError.message : "Failed to set active cycle.");
    }
  }

  const activeCycles = cycles.filter((cycle) => cycle.status === "active");
  const archivedCycles = cycles.filter((cycle) => cycle.status === "archived");

  return (
    <div className="cycle-list">
      {rowError && (
        <p className="form-error" role="alert">
          {rowError}
        </p>
      )}

      <div className="cycle-list__cards">
        {activeCycles.map((cycle) => (
          <CycleCard
            key={cycle.id}
            cycle={cycle}
            isActive={activeCycleId === cycle.id}
            onArchive={() => void handleArchive(cycle.id)}
            onActivate={() => void handleActivate(cycle.id)}
            isArchiving={archiveMutation.isPending}
            isActivating={activateMutation.isPending}
          />
        ))}
      </div>

      {showCreateForm ? (
        <CycleForm
          isSubmitting={createMutation.isPending}
          submitError={createMutation.isError ? createMutation.error.message : undefined}
          onCancel={() => setShowCreateForm(false)}
          onSubmit={(payload) => {
            createMutation.mutate(payload, { onSuccess: () => setShowCreateForm(false) });
          }}
        />
      ) : (
        <button type="button" className="button button--secondary" onClick={() => setShowCreateForm(true)}>
          + New cycle
        </button>
      )}

      {archivedCycles.length > 0 && (
        <section className="cycle-list__archived">
          <h3>Archived cycles</h3>
          <div className="cycle-list__cards">
            {archivedCycles.map((cycle) => (
              <CycleCard
                key={cycle.id}
                cycle={cycle}
                isActive={false}
                onArchive={() => {}}
                onActivate={() => {}}
                isArchiving={false}
                isActivating={false}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
