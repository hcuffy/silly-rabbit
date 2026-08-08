export function FieldHint({ text }: { text: string }) {
  return (
    <span className="field-hint" tabIndex={0} aria-label={text} data-tooltip={text}>
      ?
    </span>
  );
}
