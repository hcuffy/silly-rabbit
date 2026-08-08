import { maskErrorMessage } from "./mask.js";
import { normalizeUrl } from "./screenId.js";
import type { CapturedObservation, FindingDraft } from "./types.js";

export function runOracle(observation: CapturedObservation, screenId: string): FindingDraft[] {
  const drafts: FindingDraft[] = [];

  for (const message of observation.consoleErrors ?? []) {
    drafts.push({
      screenId,
      type: "CONSOLE_ERROR",
      evidence: { consoleMessages: [message] },
      maskedSignature: maskErrorMessage(message),
    });
  }

  for (const httpError of observation.httpErrors ?? []) {
    const statusClass = `${Math.floor(httpError.status / 100)}xx`;
    drafts.push({
      screenId,
      type: "HTTP_ERROR",
      evidence: {
        networkErrors: [{ method: httpError.method, url: httpError.url, status: httpError.status }],
      },
      maskedSignature: `${httpError.method} ${normalizeUrl(httpError.url)} ${statusClass}`,
    });
  }

  if (observation.isBlank) {
    drafts.push({ screenId, type: "BLANK_SCREEN", evidence: {}, maskedSignature: "" });
  }

  return drafts;
}
