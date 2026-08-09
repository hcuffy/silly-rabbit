import { FieldHint } from "./FieldHint.js";

export function FieldLabel({
  htmlFor,
  label,
  required = false,
  hint,
}: {
  htmlFor: string;
  label: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="field-label">
      <label htmlFor={htmlFor}>{label}</label>
      {required && (
        <span className="field-required" aria-hidden="true">
          *
        </span>
      )}
      {hint && <FieldHint text={hint} />}
    </div>
  );
}
