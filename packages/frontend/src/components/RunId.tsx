const TRUNCATED_LENGTH = 8;

export function RunId({ id }: { id: string }) {
  return (
    <span className="run-id" title={id}>
      <code className="run-id__short">{id.slice(0, TRUNCATED_LENGTH)}</code>
      <button
        type="button"
        className="run-id__copy"
        aria-label="Copy full run ID"
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(id);
        }}
      >
        Copy
      </button>
    </span>
  );
}
