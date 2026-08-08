import type { Finding } from "@silly-rabbit/shared";
import { reproDownloadUrl, screenshotUrl } from "../lib/apiClient.js";
import { usePixelDiff } from "../lib/queries.js";
import { EvidenceDiff } from "./EvidenceDiff.js";

function evidenceSummary(finding: Finding): string {
  const { evidence } = finding;
  const parts: string[] = [];
  if (evidence.consoleMessages && evidence.consoleMessages.length > 0) {
    parts.push(`${evidence.consoleMessages.length} console message(s)`);
  }
  if (evidence.networkErrors && evidence.networkErrors.length > 0) {
    parts.push(`${evidence.networkErrors.length} network error(s)`);
  }
  if (evidence.ariaSnapshot) {
    const firstLine = evidence.ariaSnapshot.split("\n")[0] ?? "";
    parts.push(`aria: ${firstLine}`);
  }
  return parts.length > 0 ? parts.join(", ") : "No evidence recorded.";
}

export function FindingCard({ finding, isActive = false }: { finding: Finding; isActive?: boolean }) {
  const hasPixelDiffInputs = Boolean(finding.beforeScreenshotPath && finding.screenshotPath);
  const { data: pixelDiffScore } = usePixelDiff(finding.id, hasPixelDiffInputs);

  const verdictClass = finding.verdict ? ` finding-card--verdict-${finding.verdict.toLowerCase()}` : "";

  return (
    <li className={`finding-card${verdictClass}${isActive ? " finding-card--active" : ""}`}>
      <div className="finding-card__header">
        <span className="finding-card__type">{finding.type}</span>
        {finding.verdict && (
          <span className={`finding-card__verdict finding-card__verdict--${finding.verdict.toLowerCase()}`}>
            {finding.verdict}
          </span>
        )}
        {finding.severity && <span className="finding-card__severity">{finding.severity}</span>}
        {finding.escalatedToOpus === true && <span className="finding-card__escalated">Opus</span>}
        {finding.confidence !== undefined && (
          <span className="finding-card__confidence">confidence {Math.round(finding.confidence * 100)}%</span>
        )}
        {finding.status === "DISMISSED" && <span className="finding-card__status">DISMISSED</span>}
      </div>
      {finding.reasoning && <p className="finding-card__reasoning">{finding.reasoning}</p>}
      {finding.explanation && <p className="finding-card__explanation">{finding.explanation}</p>}
      {finding.evidence.ariaSnapshot && finding.evidence.ariaSnapshotBefore ? (
        <EvidenceDiff before={finding.evidence.ariaSnapshotBefore} after={finding.evidence.ariaSnapshot} />
      ) : (
        <p className="finding-card__evidence">{evidenceSummary(finding)}</p>
      )}
      {finding.screenshotPath && (
        <a className="finding-card__screenshot-link" href={screenshotUrl(finding.id)} target="_blank" rel="noreferrer">
          <img className="finding-card__screenshot" src={screenshotUrl(finding.id)} alt="Screenshot at time of finding" />
        </a>
      )}
      {pixelDiffScore !== undefined && (
        <span className="finding-card__pixel-diff">pixel diff {(pixelDiffScore * 100).toFixed(1)}%</span>
      )}
      {finding.reproSpecPath && (
        <a className="finding-card__repro-link" href={reproDownloadUrl(finding.id)} download>
          Download repro
        </a>
      )}
    </li>
  );
}
