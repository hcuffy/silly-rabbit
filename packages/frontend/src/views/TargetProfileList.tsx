import { useState } from "react";
import {
  useActivateTargetProfile,
  useActiveTargetProfileId,
  useCreateTargetProfile,
  useDeactivateTargetProfile,
  useDeleteTargetProfile,
  useTargetProfilesList,
  useUpdateTargetProfile,
} from "../lib/queries.js";
import { TargetProfileForm } from "./TargetProfileForm.js";

export function TargetProfileList() {
  const { data: profiles, isPending, isError, error } = useTargetProfilesList();
  const { data: activeProfileId } = useActiveTargetProfileId();
  const createMutation = useCreateTargetProfile();
  const updateMutation = useUpdateTargetProfile();
  const deleteMutation = useDeleteTargetProfile();
  const activateMutation = useActivateTargetProfile();
  const deactivateMutation = useDeactivateTargetProfile();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [rowError, setRowError] = useState<string | undefined>(undefined);

  if (isPending) return <p>Loading target profiles…</p>;
  if (isError) {
    return (
      <p className="form-error" role="alert">
        Failed to load target profiles: {error.message}
      </p>
    );
  }

  async function handleDelete(id: string, name: string): Promise<void> {
    if (!window.confirm(`Delete target profile "${name}"? This cannot be undone.`)) return;
    setRowError(undefined);
    try {
      await deleteMutation.mutateAsync(id);
    } catch (deleteError) {
      setRowError(deleteError instanceof Error ? deleteError.message : "Failed to delete profile.");
    }
  }

  async function handleToggleActive(id: string): Promise<void> {
    setRowError(undefined);
    try {
      if (activeProfileId === id) {
        await deactivateMutation.mutateAsync();
      } else {
        await activateMutation.mutateAsync(id);
      }
    } catch (toggleError) {
      setRowError(toggleError instanceof Error ? toggleError.message : "Failed to change active profile.");
    }
  }

  return (
    <div className="target-profile-list">
      {rowError && (
        <p className="form-error" role="alert">
          {rowError}
        </p>
      )}

      {profiles.length === 0 ? (
        <p>No target profiles yet — runs use the server's .env configuration until you create one.</p>
      ) : (
        <table className="run-history">
          <thead>
            <tr>
              <th>Name</th>
              <th>Base URL</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => {
              const isActive = activeProfileId === profile.id;
              if (editingId === profile.id) {
                return (
                  <tr key={profile.id}>
                    <td colSpan={4}>
                      <TargetProfileForm
                        mode="edit"
                        initial={profile}
                        isSubmitting={updateMutation.isPending}
                        submitError={updateMutation.isError ? updateMutation.error.message : undefined}
                        onCancel={() => setEditingId(undefined)}
                        onSubmit={(payload) => {
                          updateMutation.mutate(
                            { id: profile.id, patch: payload },
                            { onSuccess: () => setEditingId(undefined) },
                          );
                        }}
                      />
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={profile.id}>
                  <td>{profile.name}</td>
                  <td>{profile.baseUrl}</td>
                  <td>
                    <span className={`status-badge status-badge--${isActive ? "active" : "inactive"}`}>
                      {isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="target-profile-list__actions">
                    <button
                      type="button"
                      disabled={activateMutation.isPending || deactivateMutation.isPending}
                      onClick={() => void handleToggleActive(profile.id)}
                    >
                      {isActive ? "Deactivate" : "Activate"}
                    </button>
                    <button type="button" onClick={() => setEditingId(profile.id)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button-danger"
                      disabled={deleteMutation.isPending}
                      onClick={() => void handleDelete(profile.id, profile.name)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showCreateForm ? (
        <TargetProfileForm
          mode="create"
          isSubmitting={createMutation.isPending}
          submitError={createMutation.isError ? createMutation.error.message : undefined}
          onCancel={() => setShowCreateForm(false)}
          onSubmit={(payload) => {
            createMutation.mutate(payload, { onSuccess: () => setShowCreateForm(false) });
          }}
        />
      ) : (
        <button type="button" onClick={() => setShowCreateForm(true)}>
          + New target profile
        </button>
      )}
    </div>
  );
}
