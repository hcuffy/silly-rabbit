import { useEffect, useState } from "react";
import { FieldHint } from "../components/FieldHint.js";
import { useCrawlNavMap, useDeleteNavMap, useNavMap } from "../lib/navMapQueries.js";
import { useActiveTargetProfileId, useTargetProfilesList } from "../lib/queries.js";

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function NavMapPanel() {
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [queriedBaseUrl, setQueriedBaseUrl] = useState<string | undefined>(undefined);
  const [defaultApplied, setDefaultApplied] = useState(false);

  const { data: profiles } = useTargetProfilesList();
  const { data: activeProfileId } = useActiveTargetProfileId();
  const navMapQuery = useNavMap(queriedBaseUrl);
  const crawlMutation = useCrawlNavMap();
  const deleteMutation = useDeleteNavMap();

  useEffect(() => {
    if (defaultApplied || !activeProfileId || !profiles) return;
    const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
    if (activeProfile) {
      setBaseUrlInput(activeProfile.baseUrl);
      setQueriedBaseUrl(activeProfile.baseUrl);
    }
    setDefaultApplied(true);
  }, [activeProfileId, profiles, defaultApplied]);

  function handleBlur(): void {
    if (isValidUrl(baseUrlInput) && baseUrlInput !== queriedBaseUrl) {
      setQueriedBaseUrl(baseUrlInput);
    }
  }

  function handleCrawl(): void {
    if (!isValidUrl(baseUrlInput)) return;
    setQueriedBaseUrl(baseUrlInput);
    crawlMutation.mutate(baseUrlInput);
  }

  async function handleDelete(): Promise<void> {
    if (!queriedBaseUrl) return;
    if (!window.confirm(`Delete the NavMap for "${queriedBaseUrl}"? This cannot be undone.`)) return;
    await deleteMutation.mutateAsync(queriedBaseUrl);
  }

  const navMap = navMapQuery.data;

  return (
    <div className="nav-map-panel">
      <h3>NavMap</h3>
      <p>Crawl a target's nav structure once, then reuse it to speed up and de-risk later explorer runs.</p>

      <div className="field-label">
        <label htmlFor="nav-map-base-url">Target base URL</label>
        <FieldHint text="Defaults to the active target profile's baseUrl, if one's active — still editable." />
      </div>
      <input
        id="nav-map-base-url"
        type="text"
        value={baseUrlInput}
        onChange={(event) => setBaseUrlInput(event.target.value)}
        onBlur={handleBlur}
        placeholder="https://dev.rabbit.example"
      />

      <div className="nav-map-panel__actions">
        <button type="button" disabled={!isValidUrl(baseUrlInput) || crawlMutation.isPending} onClick={handleCrawl}>
          {crawlMutation.isPending ? "Crawling…" : "Crawl"}
        </button>
        {navMap && (
          <button type="button" className="button-danger" disabled={deleteMutation.isPending} onClick={() => void handleDelete()}>
            {deleteMutation.isPending ? "Deleting…" : "Delete map"}
          </button>
        )}
      </div>

      {crawlMutation.isPending && (
        <p role="status">Crawling — a real browser is visiting this target's nav, this can take a while…</p>
      )}
      {crawlMutation.isError && (
        <p className="form-error" role="alert">
          Crawl failed: {crawlMutation.error.message}
        </p>
      )}
      {deleteMutation.isError && (
        <p className="form-error" role="alert">
          Delete failed: {deleteMutation.error.message}
        </p>
      )}
      {navMapQuery.isError && (
        <p className="form-error" role="alert">
          Failed to load NavMap: {navMapQuery.error.message}
        </p>
      )}

      {queriedBaseUrl && !crawlMutation.isPending && navMapQuery.isSuccess && !navMap && (
        <p>No NavMap yet for this baseUrl. Click Crawl to build one.</p>
      )}

      {navMap && (
        <div className="nav-map-panel__result">
          <p>
            {navMap.entries.length} entr{navMap.entries.length === 1 ? "y" : "ies"} mapped, crawled{" "}
            {new Date(navMap.crawledAt).toLocaleString()}.
          </p>
          <table className="run-history">
            <thead>
              <tr>
                <th>Label</th>
                <th>Role</th>
                <th>URL</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {navMap.entries.map((entry) => (
                <tr key={`${entry.role}::${entry.label}`}>
                  <td>{entry.parentLabel ? `${entry.parentLabel} › ${entry.label}` : entry.label}</td>
                  <td>{entry.role}</td>
                  <td>{entry.normalizedUrl ?? "—"}</td>
                  <td>
                    <span className={`status-badge status-badge--${entry.isStale ? "inactive" : "active"}`}>
                      {entry.isStale ? "Stale" : "Fresh"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
