import { unlink } from "node:fs/promises";
import type { FindingRepo } from "./repos/findingRepo.js";
import type { RunRepo } from "./repos/runRepo.js";
import type { SessionRecordingRepo } from "./repos/sessionRecordingRepo.js";
import type { SessionReplayRunRepo } from "./repos/sessionReplayRunRepo.js";
import type { TestRunRepo } from "./repos/testRunRepo.js";

async function unlinkIfPresent(path: string | undefined): Promise<void> {
  if (!path) {
    return;
  }
  try {
    await unlink(path);
  } catch {
    /* empty */
  }
}

async function unlinkFindingFiles(finding: { screenshotPath?: string; beforeScreenshotPath?: string; reproSpecPath?: string }): Promise<void> {
  await Promise.all([unlinkIfPresent(finding.screenshotPath), unlinkIfPresent(finding.beforeScreenshotPath), unlinkIfPresent(finding.reproSpecPath)]);
}

export interface RunCascadeDeps {
  runRepo: RunRepo;
  testRunRepo: TestRunRepo;
  findingRepo: FindingRepo;
}

export interface RunCascadeResult {
  deletedFindings: number;
  deletedTestRun: boolean;
}

export interface RunCascadePreview {
  findingCount: number;
  findingsWithScreenshots: number;
  hasTestRun: boolean;
}

export async function previewRunCascade(runId: string, deps: RunCascadeDeps): Promise<RunCascadePreview> {
  const findings = await deps.findingRepo.findByRunIds([runId]);
  const testRun = await deps.testRunRepo.getByRunId(runId);
  return {
    findingCount: findings.length,
    findingsWithScreenshots: findings.filter((finding) => finding.screenshotPath !== undefined || finding.beforeScreenshotPath !== undefined).length,
    hasTestRun: testRun !== null,
  };
}

const inFlightRunDeletes = new Map<string, Promise<RunCascadeResult>>();

export function deleteRunCascade(runId: string, deps: RunCascadeDeps): Promise<RunCascadeResult> {
  const existingJob = inFlightRunDeletes.get(runId);
  if (existingJob) {
    return existingJob;
  }

  const job = performRunCascadeDelete(runId, deps);
  inFlightRunDeletes.set(runId, job);
  job.finally(() => inFlightRunDeletes.delete(runId)).catch(() => {});
  return job;
}

async function performRunCascadeDelete(runId: string, deps: RunCascadeDeps): Promise<RunCascadeResult> {
  const findings = await deps.findingRepo.findByRunIds([runId]);
  await Promise.all(findings.map(unlinkFindingFiles));
  await deps.findingRepo.deleteByRunIds([runId]);

  const testRun = await deps.testRunRepo.getByRunId(runId);
  if (testRun) {
    await deps.testRunRepo.delete(testRun.id);
  }

  await deps.runRepo.delete(runId);

  return { deletedFindings: findings.length, deletedTestRun: testRun !== null };
}

export interface SessionReplayRunCascadeDeps {
  sessionReplayRunRepo: SessionReplayRunRepo;
  findingRepo: FindingRepo;
}

export interface SessionReplayRunCascadeResult {
  deletedFindings: number;
}

export interface SessionReplayRunCascadePreview {
  findingCount: number;
  findingsWithScreenshots: number;
}

export async function previewSessionReplayRunCascade(
  sessionReplayRunId: string,
  deps: SessionReplayRunCascadeDeps,
): Promise<SessionReplayRunCascadePreview> {
  const findings = await deps.findingRepo.findByRunIds([sessionReplayRunId]);
  return {
    findingCount: findings.length,
    findingsWithScreenshots: findings.filter((finding) => finding.screenshotPath !== undefined || finding.beforeScreenshotPath !== undefined).length,
  };
}

const inFlightSessionReplayRunDeletes = new Map<string, Promise<SessionReplayRunCascadeResult>>();

export function deleteSessionReplayRunCascade(sessionReplayRunId: string, deps: SessionReplayRunCascadeDeps): Promise<SessionReplayRunCascadeResult> {
  const existingJob = inFlightSessionReplayRunDeletes.get(sessionReplayRunId);
  if (existingJob) {
    return existingJob;
  }

  const job = performSessionReplayRunCascadeDelete(sessionReplayRunId, deps);
  inFlightSessionReplayRunDeletes.set(sessionReplayRunId, job);
  job.finally(() => inFlightSessionReplayRunDeletes.delete(sessionReplayRunId)).catch(() => {});
  return job;
}

async function performSessionReplayRunCascadeDelete(
  sessionReplayRunId: string,
  deps: SessionReplayRunCascadeDeps,
): Promise<SessionReplayRunCascadeResult> {
  const findings = await deps.findingRepo.findByRunIds([sessionReplayRunId]);
  await Promise.all(findings.map(unlinkFindingFiles));
  await deps.findingRepo.deleteByRunIds([sessionReplayRunId]);
  await deps.sessionReplayRunRepo.delete(sessionReplayRunId);

  return { deletedFindings: findings.length };
}

export interface SessionRecordingCascadeDeps extends SessionReplayRunCascadeDeps {
  sessionRecordingRepo: SessionRecordingRepo;
}

export interface SessionRecordingCascadeResult {
  deletedSessionReplayRuns: number;
  deletedFindings: number;
}

export interface SessionRecordingCascadePreview {
  sessionReplayRunCount: number;
  findingCount: number;
}

export async function previewSessionRecordingCascade(sessionId: string, deps: SessionRecordingCascadeDeps): Promise<SessionRecordingCascadePreview> {
  const replayRuns = await deps.sessionReplayRunRepo.findBySessionId(sessionId);
  const previews = await Promise.all(replayRuns.map((run) => previewSessionReplayRunCascade(run.id, deps)));
  return {
    sessionReplayRunCount: replayRuns.length,
    findingCount: previews.reduce((sum, preview) => sum + preview.findingCount, 0),
  };
}

const inFlightSessionRecordingDeletes = new Map<string, Promise<SessionRecordingCascadeResult>>();

export function deleteSessionRecordingCascade(sessionId: string, deps: SessionRecordingCascadeDeps): Promise<SessionRecordingCascadeResult> {
  const existingJob = inFlightSessionRecordingDeletes.get(sessionId);
  if (existingJob) {
    return existingJob;
  }

  const job = performSessionRecordingCascadeDelete(sessionId, deps);
  inFlightSessionRecordingDeletes.set(sessionId, job);
  job.finally(() => inFlightSessionRecordingDeletes.delete(sessionId)).catch(() => {});
  return job;
}

async function performSessionRecordingCascadeDelete(sessionId: string, deps: SessionRecordingCascadeDeps): Promise<SessionRecordingCascadeResult> {
  const replayRuns = await deps.sessionReplayRunRepo.findBySessionId(sessionId);
  const replayRunIds = replayRuns.map((run) => run.id);

  const findings = await deps.findingRepo.findByRunIds(replayRunIds);
  await Promise.all(findings.map(unlinkFindingFiles));
  await deps.findingRepo.deleteByRunIds(replayRunIds);
  await deps.sessionReplayRunRepo.deleteByIds(replayRunIds);
  await deps.sessionRecordingRepo.delete(sessionId);

  return {
    deletedSessionReplayRuns: replayRuns.length,
    deletedFindings: findings.length,
  };
}

export async function deleteFinding(
  finding: { id: string; screenshotPath?: string; beforeScreenshotPath?: string; reproSpecPath?: string },
  findingRepo: FindingRepo,
): Promise<void> {
  await unlinkFindingFiles(finding);
  await findingRepo.hardDelete(finding.id);
}
