import { FieldHint } from "./FieldHint.js";

interface FieldLabelProps {
  htmlFor: string;
  label: string;
  required?: boolean;
  hint?: string;
}

export function FieldLabel(props: FieldLabelProps) {
  const { htmlFor, label, required = false, hint } = props;
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
