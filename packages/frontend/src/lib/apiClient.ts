import {
  FeatureDocumentSchema,
  FindingSchema,
  RunSchema,
  SessionRecordingSchema,
  SessionRecordingStepSchema,
  SessionReplayRunSchema,
  TestRunSchema,
  type FeatureDocument,
  type Finding,
  type Run,
  type SessionRecording,
  type SessionRecordingStep,
  type SessionReplayRun,
  type TestRun,
} from "@silly-rabbit/shared";
import { z } from "zod";

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `request failed with status ${response.status}`, response.status);
  }
  return response;
}

export function reviveDates<T extends Record<string, unknown>>(raw: T, dateKeys: readonly string[]): T {
  const revived: Record<string, unknown> = { ...raw };
  for (const key of dateKeys) {
    const value = revived[key];
    if (typeof value === "string") {
      revived[key] = new Date(value);
    }
  }
  return revived as T;
}

const RUN_DATE_KEYS = ["startedAt", "finishedAt"] as const;
const FINDING_DATE_KEYS = ["createdAt", "updatedAt"] as const;
const RESEARCH_DATE_KEYS = ["capturedAt"] as const;
const FEATURE_DOC_DATE_KEYS = ["generatedAt"] as const;

function parseRun(raw: unknown): Run {
  return RunSchema.parse(reviveDates(raw as Record<string, unknown>, RUN_DATE_KEYS));
}

function parseFinding(raw: unknown): Finding {
  return FindingSchema.parse(reviveDates(raw as Record<string, unknown>, FINDING_DATE_KEYS));
}

function parseFeatureDocument(raw: unknown): FeatureDocument {
  return FeatureDocumentSchema.parse(reviveDates(raw as Record<string, unknown>, FEATURE_DOC_DATE_KEYS));
}

function parseTestRun(raw: unknown): TestRun {
  const record = raw as Record<string, unknown>;
  return TestRunSchema.parse({
    ...reviveDates(record, RUN_DATE_KEYS),
    research: reviveDates(record.research as Record<string, unknown>, RESEARCH_DATE_KEYS),
  });
}

export interface RunDetail extends Run {
  testRun: TestRun | null;
  findings: Finding[];
}

function parseRunDetail(raw: unknown): RunDetail {
  const record = raw as Record<string, unknown>;
  return {
    ...parseRun(record),
    testRun: record.testRun ? parseTestRun(record.testRun) : null,
    findings: (record.findings as unknown[]).map(parseFinding),
  };
}

const CreateRunResponseSchema = z.object({ runId: z.string(), status: z.string() });
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

export const CreateRunInputSchema = z.object({
  charter: z.string().trim().min(1, "Charter is required."),
  targetBaseUrl: z.string().trim().url("Target base URL must be a valid URL."),
  cycleId: z.string().uuid().optional(),
});
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;

export async function createRun(input: CreateRunInput): Promise<CreateRunResponse> {
  const parsedInput = CreateRunInputSchema.parse(input);
  const response = await request("/runs", { method: "POST", body: JSON.stringify(parsedInput) });
  return CreateRunResponseSchema.parse(await response.json());
}

export interface RunsPage {
  runs: Run[];
  total: number;
}

export async function listRuns({ limit, offset, cycleId }: { limit: number; offset: number; cycleId?: string }): Promise<RunsPage> {
  const cycleParameter = cycleId ? `&cycleId=${encodeURIComponent(cycleId)}` : "";
  const response = await request(`/runs?limit=${limit}&offset=${offset}${cycleParameter}`);
  const body = (await response.json()) as { runs: unknown[]; total: number };
  return { runs: body.runs.map(parseRun), total: body.total };
}

export async function getRunDetail(id: string): Promise<RunDetail> {
  const response = await request(`/explorer/runs/${id}`);
  return parseRunDetail(await response.json());
}

export const CreateExplorerRunInputSchema = z.object({
  featureId: z.string().trim().min(1, "Feature name is required."),
  sectionDescription: z.string().trim().min(1, "Section description is required."),
  targetBaseUrl: z.string().trim().url("Target base URL must be a valid URL."),
  cycleId: z.string().uuid().optional(),
});
export type CreateExplorerRunInput = z.infer<typeof CreateExplorerRunInputSchema>;

export async function createExplorerRun(input: CreateExplorerRunInput): Promise<CreateRunResponse> {
  const parsedInput = CreateExplorerRunInputSchema.parse(input);
  const response = await request("/explorer/runs", { method: "POST", body: JSON.stringify(parsedInput) });
  return CreateRunResponseSchema.parse(await response.json());
}

export type FeedbackVerdict = "confirmed_issue" | "intended_behavior" | "dismiss";

export async function submitFindingFeedback(findingId: string, verdict: FeedbackVerdict): Promise<void> {
  await request(`/findings/${findingId}/feedback`, { method: "POST", body: JSON.stringify({ verdict }) });
}

export async function getFinding(id: string): Promise<Finding> {
  const response = await request(`/findings/${id}`);
  return parseFinding(await response.json());
}

export function reproDownloadUrl(findingId: string): string {
  return `${API_BASE_URL}/findings/${findingId}/repro`;
}

export function screenshotUrl(findingId: string): string {
  return `${API_BASE_URL}/findings/${findingId}/screenshot`;
}

const PixelDiffResponseSchema = z.object({ pixelDiffScore: z.number() });

export async function getPixelDiff(findingId: string): Promise<number | undefined> {
  try {
    const response = await request(`/findings/${findingId}/pixel-diff`);
    return PixelDiffResponseSchema.parse(await response.json()).pixelDiffScore;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 422)) {
      return undefined;
    }
    throw error;
  }
}

export async function login(password: string): Promise<void> {
  await request("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
}

export async function getSession(): Promise<true> {
  await request("/auth/session");
  return true;
}

const TargetStatsResponseSchema = z.object({
  newCount: z.number(),
  suppressedCount: z.number(),
  agree: z.number(),
  disagree: z.number(),
});
export type TargetStats = z.infer<typeof TargetStatsResponseSchema>;

export async function getTargetStats(targetBaseUrl: string): Promise<TargetStats> {
  const response = await request(`/findings/stats?targetBaseUrl=${encodeURIComponent(targetBaseUrl)}`);
  return TargetStatsResponseSchema.parse(await response.json());
}

export async function triggerFeatureDocumentGeneration(featureId: string): Promise<FeatureDocument> {
  const response = await request(`/features/${encodeURIComponent(featureId)}/docs`, { method: "POST" });
  return parseFeatureDocument(await response.json());
}

export async function listFeatureDocuments(featureId: string): Promise<FeatureDocument[]> {
  const response = await request(`/features/${encodeURIComponent(featureId)}/docs`);
  const body = (await response.json()) as unknown[];
  return body.map(parseFeatureDocument);
}

const SESSION_RECORDING_DATE_KEYS = ["recordedAt"] as const;
const SESSION_REPLAY_RUN_DATE_KEYS = ["startedAt", "completedAt"] as const;

function parseSessionRecording(raw: unknown): SessionRecording {
  return SessionRecordingSchema.parse(reviveDates(raw as Record<string, unknown>, SESSION_RECORDING_DATE_KEYS));
}

function parseSessionReplayRun(raw: unknown): SessionReplayRun {
  return SessionReplayRunSchema.parse(reviveDates(raw as Record<string, unknown>, SESSION_REPLAY_RUN_DATE_KEYS));
}

export interface SessionReplayRunDetail extends SessionReplayRun {
  findings: Finding[];
  steps: SessionRecordingStep[];
}

function parseSessionReplayRunDetail(raw: unknown): SessionReplayRunDetail {
  const record = raw as Record<string, unknown>;
  return {
    ...parseSessionReplayRun(record),
    findings: (record.findings as unknown[]).map(parseFinding),
    steps: (record.steps as unknown[]).map((step) => SessionRecordingStepSchema.parse(step)),
  };
}

export async function listSessionRecordings(): Promise<SessionRecording[]> {
  const response = await request("/session-recordings");
  const body = (await response.json()) as unknown[];
  return body.map(parseSessionRecording);
}

export const TriggerSessionReplayRunInputSchema = z.object({
  sessionId: z.string().uuid(),
  replayMode: z.enum(["live", "mocked"]).optional(),
  cycleId: z.string().uuid().optional(),
});
export type TriggerSessionReplayRunInput = z.infer<typeof TriggerSessionReplayRunInputSchema>;

export async function triggerSessionReplayRun(input: TriggerSessionReplayRunInput): Promise<CreateRunResponse> {
  const parsedInput = TriggerSessionReplayRunInputSchema.parse(input);
  const response = await request("/session-replay/runs", { method: "POST", body: JSON.stringify(parsedInput) });
  return CreateRunResponseSchema.parse(await response.json());
}

export async function getSessionReplayRunDetail(id: string): Promise<SessionReplayRunDetail> {
  const response = await request(`/session-replay/runs/${id}`);
  return parseSessionReplayRunDetail(await response.json());
}

export interface SessionReplayRunsPage {
  sessionReplayRuns: SessionReplayRun[];
  total: number;
}

export async function listSessionReplayRuns({
  limit,
  offset,
  cycleId,
}: {
  limit: number;
  offset: number;
  cycleId?: string;
}): Promise<SessionReplayRunsPage> {
  const cycleParameter = cycleId ? `&cycleId=${encodeURIComponent(cycleId)}` : "";
  const response = await request(`/session-replay/runs?limit=${limit}&offset=${offset}${cycleParameter}`);
  const body = (await response.json()) as { sessionReplayRuns: unknown[]; total: number };
  return { sessionReplayRuns: body.sessionReplayRuns.map(parseSessionReplayRun), total: body.total };
}
