import { useState } from "react";

const TRUNCATED_LENGTH = 8;
const COPY_FEEDBACK_DURATION_MS = 1500;

export function RunId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
  }

  return (
    <span className="run-id" title={id}>
      <code className="run-id__short">{id.slice(0, TRUNCATED_LENGTH)}</code>
      <button
        type="button"
        className="run-id__copy"
        aria-label="Copy full run ID"
        onClick={(event) => {
          event.stopPropagation();
          void handleCopy();
        }}>
        {copied ? "Copied!" : "Copy"}
      </button>
    </span>
  );
}
