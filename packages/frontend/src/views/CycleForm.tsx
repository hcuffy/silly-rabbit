import { useState, type FormEvent } from "react";
import { CycleWriteInputSchema, type CycleWriteInput } from "../lib/cycleApiClient.js";
import { findEmptyRequiredFields, focusFirstInvalidField } from "../lib/requiredFieldValidation.js";

const NAME_REQUIRED_MESSAGE = "Name is required.";

interface CycleFormProps {
  onSubmit: (payload: CycleWriteInput) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  submitError?: string;
}

export function CycleForm(props: CycleFormProps) {
  const { onSubmit, onCancel, isSubmitting, submitError } = props;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"sprint" | "release">("release");
  const [validationError, setValidationError] = useState<string | undefined>(undefined);
  const [invalidFields, setInvalidFields] = useState<Set<string>>(new Set());

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const requiredFields = [{ key: "name", id: "cycleName", value: name }];
    const emptyFields = findEmptyRequiredFields(requiredFields);
    if (emptyFields.size > 0) {
      setInvalidFields(emptyFields);
      focusFirstInvalidField(requiredFields, emptyFields);
      return;
    }
    setInvalidFields(new Set());

    const parsed = CycleWriteInputSchema.safeParse({ name, kind });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      return;
    }
    setValidationError(undefined);
    onSubmit(parsed.data);
  }

  return (
    <form className="new-run-form" onSubmit={handleSubmit} noValidate>
      <h3>New cycle</h3>
      <div className="field-label">
        <label htmlFor="cycleName">Name</label>
        <span className="field-required" aria-hidden="true">
          *
        </span>
      </div>
      <input
        id="cycleName"
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Release 3.22"
        required
        aria-invalid={invalidFields.has("name")}
      />
      {invalidFields.has("name") && (
        <p className="form-error" role="alert">
          {NAME_REQUIRED_MESSAGE}
        </p>
      )}
      <div className="field-label">
        <label htmlFor="cycleKind">Kind</label>
        <span className="field-required" aria-hidden="true">
          *
        </span>
      </div>
      <select id="cycleKind" value={kind} onChange={(event) => setKind(event.target.value as "sprint" | "release")} required>
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
