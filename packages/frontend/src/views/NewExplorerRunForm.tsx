import { useState, type FormEvent } from "react";
import { CreateExplorerRunInputSchema } from "../lib/apiClient.js";
import { CycleSelect } from "../components/CycleSelect.js";
import { FieldHint } from "../components/FieldHint.js";
import { getLastUsedCycleId, setLastUsedCycleId } from "../lib/lastUsedCycle.js";
import { useCreateExplorerRun } from "../lib/queries.js";

const EXAMPLE_SECTION_DESCRIPTIONS: readonly string[] = [
  "the locations list and detail view",
  "billing and invoices",
  "user account settings",
  "the checkout and payment page",
];

export function NewExplorerRunForm({ onCreated }: { onCreated: (runId: string) => void }) {
  const [featureId, setFeatureId] = useState("");
  const [sectionDescription, setSectionDescription] = useState("");
  const [targetBaseUrl, setTargetBaseUrl] = useState("");
  const [cycleId, setCycleId] = useState(() => getLastUsedCycleId() ?? "");
  const [validationError, setValidationError] = useState<string | undefined>(undefined);
  const mutation = useCreateExplorerRun();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = CreateExplorerRunInputSchema.safeParse({
      featureId,
      sectionDescription,
      targetBaseUrl,
      cycleId: cycleId || undefined,
    });
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
      <h2>New explorer run</h2>
      <div className="field-label">
        <label htmlFor="featureId">Feature name</label>
        <FieldHint text='A short name/slug for this feature, not a sentence. Example: "billing-invoices"' />
      </div>
      <input
        id="featureId"
        type="text"
        value={featureId}
        onChange={(event) => setFeatureId(event.target.value)}
        placeholder="locations"
      />
      <div className="field-label">
        <label htmlFor="sectionDescription">Section description</label>
        <FieldHint
          text={
            'A SHORT description matching how this section appears in navigation ' +
            '(e.g. "the billing and invoices page") — NOT a multi-step instruction. ' +
            "The explorer finds the section by this description, then decides itself what to test. " +
            'Contrast with Charter above: Charter is a full instruction, this is just a label used to locate ' +
            'the section — a full instruction here causes "section not found in navigation" errors.'
          }
        />
      </div>
      <textarea
        id="sectionDescription"
        value={sectionDescription}
        onChange={(event) => setSectionDescription(event.target.value)}
        placeholder="the locations list and detail view"
        rows={3}
      />
      <select
        aria-label="Insert an example section description"
        value=""
        onChange={(event) => {
          if (event.target.value) setSectionDescription(event.target.value);
        }}
      >
        <option value="">— insert an example description —</option>
        {EXAMPLE_SECTION_DESCRIPTIONS.map((example) => (
          <option key={example} value={example}>
            {example}
          </option>
        ))}
      </select>
      <div className="field-label">
        <label htmlFor="explorerTargetBaseUrl">Target base URL</label>
        <FieldHint text="The base URL of the target app to run this explorer session against (scheme + host, no path)." />
      </div>
      <input
        id="explorerTargetBaseUrl"
        type="text"
        value={targetBaseUrl}
        onChange={(event) => setTargetBaseUrl(event.target.value)}
        placeholder="https://dev.rabbit.example"
      />
      <CycleSelect id="explorerCycleId" label="Cycle" value={cycleId} onChange={setCycleId} />
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Starting…" : "Run explorer"}
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
