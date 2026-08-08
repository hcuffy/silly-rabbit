import type { FeatureDocument, Run, SessionRecording } from "@silly-rabbit/shared";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  createExplorerRun,
  createRun,
  getPixelDiff,
  getRunDetail,
  getSession,
  getSessionReplayRunDetail,
  getTargetStats,
  listFeatureDocuments,
  listRuns,
  listSessionRecordings,
  listSessionReplayRuns,
  login,
  submitFindingFeedback,
  triggerFeatureDocumentGeneration,
  triggerSessionReplayRun,
  type CreateExplorerRunInput,
  type CreateRunInput,
  type CreateRunResponse,
  type FeedbackVerdict,
  type RunDetail,
  type RunsPage,
  type SessionReplayRunDetail,
  type SessionReplayRunsPage,
  type TargetStats,
  type TriggerSessionReplayRunInput,
} from "./apiClient.js";
import {
  activateTargetProfile,
  createTargetProfile,
  deactivateTargetProfile,
  deleteTargetProfile,
  getActiveTargetProfileId,
  listTargetProfiles,
  updateTargetProfile,
  type SafeTargetProfile,
  type TargetProfilePatchInput,
  type TargetProfileWriteInput,
} from "./targetProfileApiClient.js";

const POLL_INTERVAL_MS = 2000;

export function useSessionQuery(): UseQueryResult<true> {
  return useQuery({ queryKey: ["auth", "session"], queryFn: getSession, retry: false });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: login,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["auth", "session"] });
    },
  });
}

export function isTerminalStatus(status: Run["status"] | undefined): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

export function useRunsList({
  limit,
  offset,
  cycleId,
}: {
  limit: number;
  offset: number;
  cycleId?: string;
}): UseQueryResult<RunsPage> {
  return useQuery({
    queryKey: ["runs", limit, offset, cycleId],
    queryFn: () => listRuns({ limit, offset, cycleId }),
  });
}

export function useSessionReplayRunsList({
  limit,
  offset,
  cycleId,
}: {
  limit: number;
  offset: number;
  cycleId?: string;
}): UseQueryResult<SessionReplayRunsPage> {
  return useQuery({
    queryKey: ["sessionReplayRuns", limit, offset, cycleId],
    queryFn: () => listSessionReplayRuns({ limit, offset, cycleId }),
  });
}

export function useRunDetail(id: string | undefined): UseQueryResult<RunDetail> {
  return useQuery({
    queryKey: ["runDetail", id],
    queryFn: () => getRunDetail(id as string),
    enabled: id !== undefined,
    refetchInterval: (query) => (isTerminalStatus(query.state.data?.status) ? false : POLL_INTERVAL_MS),
  });
}

export function useTargetStats(targetBaseUrl: string | undefined): UseQueryResult<TargetStats> {
  return useQuery({
    queryKey: ["targetStats", targetBaseUrl],
    queryFn: () => getTargetStats(targetBaseUrl as string),
    enabled: targetBaseUrl !== undefined,
  });
}

export function useCreateRun() {
  const queryClient = useQueryClient();
  return useMutation<CreateRunResponse, Error, CreateRunInput>({
    mutationFn: createRun,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function useCreateExplorerRun() {
  const queryClient = useQueryClient();
  return useMutation<CreateRunResponse, Error, CreateExplorerRunInput>({
    mutationFn: createExplorerRun,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function usePixelDiff(findingId: string, enabled: boolean): UseQueryResult<number | undefined> {
  return useQuery({
    queryKey: ["pixelDiff", findingId],
    queryFn: () => getPixelDiff(findingId),
    enabled,
  });
}

export function useFeatureDocumentHistory(featureId: string | undefined): UseQueryResult<FeatureDocument[]> {
  return useQuery({
    queryKey: ["featureDocs", featureId],
    queryFn: () => listFeatureDocuments(featureId as string),
    enabled: featureId !== undefined,
  });
}

export function useGenerateFeatureDocument(featureId: string) {
  const queryClient = useQueryClient();
  return useMutation<FeatureDocument, Error, void>({
    mutationFn: () => triggerFeatureDocumentGeneration(featureId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["featureDocs", featureId] });
    },
  });
}

export function useSessionRecordingsList(): UseQueryResult<SessionRecording[]> {
  return useQuery({ queryKey: ["sessionRecordings"], queryFn: listSessionRecordings });
}

export function useSessionReplayRunDetail(id: string | undefined): UseQueryResult<SessionReplayRunDetail> {
  return useQuery({
    queryKey: ["sessionReplayRunDetail", id],
    queryFn: () => getSessionReplayRunDetail(id as string),
    enabled: id !== undefined,
    refetchInterval: (query) => (isTerminalStatus(query.state.data?.status) ? false : POLL_INTERVAL_MS),
  });
}

export function useTriggerSessionReplayRun() {
  return useMutation<CreateRunResponse, Error, TriggerSessionReplayRunInput>({
    mutationFn: triggerSessionReplayRun,
  });
}

export function useFindingFeedback(runId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { findingId: string; verdict: FeedbackVerdict }>({
    mutationFn: ({ findingId, verdict }) => submitFindingFeedback(findingId, verdict),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["runDetail", runId] });
    },
  });
}

const TARGET_PROFILES_QUERY_KEY = ["targetProfiles"];
const ACTIVE_TARGET_PROFILE_QUERY_KEY = ["activeTargetProfileId"];

export function useTargetProfilesList(): UseQueryResult<SafeTargetProfile[]> {
  return useQuery({ queryKey: TARGET_PROFILES_QUERY_KEY, queryFn: listTargetProfiles });
}

export function useActiveTargetProfileId(): UseQueryResult<string | null> {
  return useQuery({ queryKey: ACTIVE_TARGET_PROFILE_QUERY_KEY, queryFn: getActiveTargetProfileId });
}

export function useCreateTargetProfile() {
  const queryClient = useQueryClient();
  return useMutation<SafeTargetProfile, Error, TargetProfileWriteInput>({
    mutationFn: createTargetProfile,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TARGET_PROFILES_QUERY_KEY });
    },
  });
}

export function useUpdateTargetProfile() {
  const queryClient = useQueryClient();
  return useMutation<SafeTargetProfile, Error, { id: string; patch: TargetProfilePatchInput }>({
    mutationFn: ({ id, patch }) => updateTargetProfile(id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TARGET_PROFILES_QUERY_KEY });
    },
  });
}

export function useDeleteTargetProfile() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: deleteTargetProfile,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TARGET_PROFILES_QUERY_KEY });
    },
  });
}

export function useActivateTargetProfile() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: activateTargetProfile,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACTIVE_TARGET_PROFILE_QUERY_KEY });
    },
  });
}

export function useDeactivateTargetProfile() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: deactivateTargetProfile,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACTIVE_TARGET_PROFILE_QUERY_KEY });
    },
  });
}
