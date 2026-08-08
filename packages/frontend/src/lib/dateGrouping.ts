const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatDayGroupLabel(date: Date, now: Date = new Date()): string {
  if (isSameCalendarDay(date, now)) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return "Yesterday";

  const sameYear = date.getFullYear() === now.getFullYear();
  const monthDay = `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
  return sameYear ? monthDay : `${monthDay}, ${date.getFullYear()}`;
}

export interface RunDayGroup<T> {
  label: string;
  runs: T[];
}

export function groupRunsByDay<T extends { startedAt: Date }>(runs: T[], now: Date = new Date()): RunDayGroup<T>[] {
  const groups: RunDayGroup<T>[] = [];
  for (const run of runs) {
    const label = formatDayGroupLabel(run.startedAt, now);
    const currentGroup = groups.at(-1);
    if (currentGroup?.label === label) {
      currentGroup.runs.push(run);
    } else {
      groups.push({ label, runs: [run] });
    }
  }
  return groups;
}
