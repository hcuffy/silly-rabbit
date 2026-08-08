import type { Cycle } from "@silly-rabbit/shared";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  activateCycle,
  archiveCycle,
  createCycle,
  getActiveCycleId,
  getCycle,
  getCycleStats,
  listCycles,
  type CycleStats,
  type CycleWriteInput,
} from "./cycleApiClient.js";

const CYCLES_QUERY_KEY = ["cycles"];
const ACTIVE_CYCLE_QUERY_KEY = ["activeCycleId"];

export function useCyclesList(status?: "active" | "archived"): UseQueryResult<Cycle[]> {
  return useQuery({ queryKey: [...CYCLES_QUERY_KEY, status], queryFn: () => listCycles(status) });
}

export function useCycle(id: string | undefined): UseQueryResult<Cycle> {
  return useQuery({
    queryKey: ["cycle", id],
    queryFn: () => getCycle(id as string),
    enabled: id !== undefined,
  });
}

export function useCycleStats(id: string | undefined): UseQueryResult<CycleStats> {
  return useQuery({
    queryKey: ["cycleStats", id],
    queryFn: () => getCycleStats(id as string),
    enabled: id !== undefined,
  });
}

export function useActiveCycleId(): UseQueryResult<string | null> {
  return useQuery({ queryKey: ACTIVE_CYCLE_QUERY_KEY, queryFn: getActiveCycleId });
}

export function useCreateCycle() {
  const queryClient = useQueryClient();
  return useMutation<Cycle, Error, CycleWriteInput>({
    mutationFn: createCycle,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CYCLES_QUERY_KEY });
    },
  });
}

export function useArchiveCycle() {
  const queryClient = useQueryClient();
  return useMutation<Cycle, Error, string>({
    mutationFn: archiveCycle,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CYCLES_QUERY_KEY });
    },
  });
}

export function useActivateCycle() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: activateCycle,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACTIVE_CYCLE_QUERY_KEY });
    },
  });
}
