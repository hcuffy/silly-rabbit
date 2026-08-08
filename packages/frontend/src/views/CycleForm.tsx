import { useState, type FormEvent } from "react";
import { CycleWriteInputSchema, type CycleWriteInput } from "../lib/cycleApiClient.js";

export function CycleForm({
  onSubmit,
  onCancel,
  isSubmitting,
  submitError,
}: {
  onSubmit: (payload: CycleWriteInput) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  submitError?: string;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"sprint" | "release">("release");
  const [validationError, setValidationError] = useState<string | undefined>(undefined);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = CycleWriteInputSchema.safeParse({ name, kind });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      return;
    }
    setValidationError(undefined);
    onSubmit(parsed.data);
  }

  return (
    <form className="new-run-form" onSubmit={handleSubmit}>
      <h3>New cycle</h3>
      <div className="field-label">
        <label htmlFor="cycleName">Name</label>
      </div>
      <input
        id="cycleName"
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Release 3.22"
      />
      <div className="field-label">
        <label htmlFor="cycleKind">Kind</label>
      </div>
      <select id="cycleKind" value={kind} onChange={(event) => setKind(event.target.value as "sprint" | "release")}>
        <option value="release">Release</option>
        <option value="sprint">Sprint</option>
      </select>
      <div className="cycle-form__actions">
        <button type="submit" className="button button--primary" disabled={isSubmitting}>
          {isSubmitting ? "Creating…" : "Create cycle"}
        </button>
        <button type="button" className="button button--secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {validationError && (
        <p className="form-error" role="alert">
          {validationError}
        </p>
      )}
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
    </form>
  );
}
