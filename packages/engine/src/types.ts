import type { Baseline, Finding } from "@silly-rabbit/shared";
import type { JudgeRunOptions } from "./judge.js";

export interface HttpErrorSignal {
  method: string;
  url: string;
  status: number;
}

export interface CapturedObservation {
  url: string;
  ariaSnapshot: string;
  documentTitle?: string;
  consoleErrors?: string[];
  httpErrors?: HttpErrorSignal[];
  isBlank?: boolean;
  screenshotBuffer?: Buffer;
}

export interface FindingDraft {
  screenId: string;
  type: Finding["type"];
  evidence: Finding["evidence"];
  maskedSignature: string;
  beforeScreenshotPath?: string;
}

export interface EngineLoopInput {
  runId: string;
  charter: string;
  observations: CapturedObservation[];
  existingBaselines: Baseline[];
  existingFindings: Finding[];
  judge: JudgeRunOptions;
  maxLlmCalls?: number;
  maxUsdPerRun?: number;
}

export interface EngineLoopOutput {
  baselines: Baseline[];
  findings: Finding[];
  llmCallsUsed: number;
  costUsd: number;
}
