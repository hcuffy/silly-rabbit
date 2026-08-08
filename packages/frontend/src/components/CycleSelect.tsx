import { useCyclesList } from "../lib/cycleQueries.js";

export function CycleSelect({
  id,
  label,
  value,
  onChange,
  hideLabel = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (cycleId: string) => void;
  hideLabel?: boolean;
}) {
  const { data: cycles, isPending } = useCyclesList("active");

  return (
    <>
      {!hideLabel && (
        <div className="field-label">
          <label htmlFor={id}>{label}</label>
        </div>
      )}
      <select
        id={id}
        aria-label={hideLabel ? label : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={isPending}
      >
        <option value="">— no cycle —</option>
        {(cycles ?? []).map((cycle) => (
          <option key={cycle.id} value={cycle.id}>
            {cycle.name}
          </option>
        ))}
      </select>
    </>
  );
}
