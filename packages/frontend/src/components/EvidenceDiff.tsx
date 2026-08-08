import { diffLines } from "diff";

interface EvidenceDiffProperties {
  before: string;
  after: string;
}

interface DiffLine {
  text: string;
  added: boolean;
  removed: boolean;
}

function splitIntoLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineClassName(line: DiffLine): string {
  if (line.added) return "evidence-diff__line evidence-diff__line--added";
  if (line.removed) return "evidence-diff__line evidence-diff__line--removed";
  return "evidence-diff__line";
}

function linePrefix(line: DiffLine): string {
  if (line.added) return "+ ";
  if (line.removed) return "- ";
  return "  ";
}

export function EvidenceDiff({ before, after }: EvidenceDiffProperties) {
  const lines: DiffLine[] = diffLines(before, after).flatMap((part) =>
    splitIntoLines(part.value).map((text) => ({ text, added: part.added ?? false, removed: part.removed ?? false })),
  );

  return (
    <pre className="evidence-diff">
      {lines.map((line, index) => (
        <div key={index} className={lineClassName(line)}>
          {linePrefix(line)}
          {line.text}
        </div>
      ))}
    </pre>
  );
}
