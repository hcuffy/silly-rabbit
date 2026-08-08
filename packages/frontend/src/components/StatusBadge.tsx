import type { Run } from "@silly-rabbit/shared";

export function StatusBadge({ status }: { status: Run["status"] }) {
  return <span className={`status-badge status-badge--${status.toLowerCase()}`}>{status}</span>;
}
