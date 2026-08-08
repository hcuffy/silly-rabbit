import { createHash } from "node:crypto";
import type { FindingDraft } from "./types.js";

export function computeDedupKey(draft: FindingDraft): string {
  return createHash("sha256").update(`${draft.screenId}:${draft.type}:${draft.maskedSignature}`).digest("hex");
}
