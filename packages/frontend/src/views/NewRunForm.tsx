import { useState, type FormEvent } from "react";
import { CreateRunInputSchema } from "../lib/apiClient.js";
import { CycleSelect } from "../components/CycleSelect.js";
import { FieldHint } from "../components/FieldHint.js";
import { getLastUsedCycleId, setLastUsedCycleId } from "../lib/lastUsedCycle.js";
import { useCreateRun } from "../lib/queries.js";

const EXAMPLE_CHARTERS: readonly string[] = [
  "test the locations flow",
  "Log in, open account settings, change the display name, and confirm it saved.",
  "Add a new item to the cart, proceed to checkout, and confirm the order summary shows the correct total.",
  "Search for a customer by name, open their profile, and verify the contact details are displayed correctly.",
];

export function NewRunForm({ onCreated }: { onCreated: (runId: string) => void }) {
  const [charter, setCharter] = useState("");
  const [targetBaseUrl, setTargetBaseUrl] = useState("");
  const [cycleId, setCycleId] = useState(() => getLastUsedCycleId() ?? "");
  const [validationError, setValidationError] = useState<string | undefined>(undefined);
  const mutation = useCreateRun();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = CreateRunInputSchema.safeParse({ charter, targetBaseUrl, cycleId: cycleId || undefined });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      return;
    }
    setValidationError(undefined);
    if (cycleId) setLastUsedCycleId(cycleId);
    mutation.mutate(parsed.data, {
      onSuccess: (response) => onCreated(response.runId),
    });
  }

  return (
    <form className="new-run-form" onSubmit={handleSubmit}>
      <h2>New run</h2>
      <div className="field-label">
        <label htmlFor="charter">Charter</label>
        <FieldHint
          text={
            'A full plain-language instruction: what to do, step by step if needed. ' +
            'Example: "Log in, open account settings, change the display name, and confirm it saved."'
          }
        />
      </div>
      <textarea
        id="charter"
        value={charter}
        onChange={(event) => setCharter(event.target.value)}
        placeholder="test the locations flow"
        rows={3}
      />
      <select
        aria-label="Insert an example charter"
        value=""
        onChange={(event) => {
          if (event.target.value) setCharter(event.target.value);
        }}
      >
        <option value="">— insert an example charter —</option>
        {EXAMPLE_CHARTERS.map((example) => (
          <option key={example} value={example}>
            {example}
          </option>
        ))}
      </select>
      <div className="field-label">
        <label htmlFor="targetBaseUrl">Target base URL</label>
        <FieldHint text="The base URL of the target app to run this charter against (scheme + host, no path)." />
      </div>
      <input
        id="targetBaseUrl"
        type="text"
        value={targetBaseUrl}
        onChange={(event) => setTargetBaseUrl(event.target.value)}
        placeholder="https://dev.rabbit.example"
      />
      <CycleSelect id="cycleId" label="Cycle" value={cycleId} onChange={setCycleId} />
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Starting…" : "Run"}
      </button>
      {validationError && (
        <p className="form-error" role="alert">
          {validationError}
        </p>
      )}
      {mutation.isError && (
        <p className="form-error" role="alert">
          {mutation.error.message}
        </p>
      )}
    </form>
  );
}
