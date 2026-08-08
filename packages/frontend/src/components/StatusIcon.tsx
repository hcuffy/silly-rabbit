import type { Run } from "@silly-rabbit/shared";

export function StatusIcon({ status }: { status: Run["status"] }) {
  return (
    <span
      className={`status-icon status-icon--${status.toLowerCase()}`}
      role="img"
      aria-label={status}
      title={status}
    />
  );
}
