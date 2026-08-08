import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { crawlNavMap, deleteNavMap, getNavMap, type NavMapDisplay } from "./navMapApiClient.js";

function navMapQueryKey(baseUrl: string | undefined): unknown[] {
  return ["navMap", baseUrl];
}

export function useNavMap(baseUrl: string | undefined): UseQueryResult<NavMapDisplay | null> {
  return useQuery({
    queryKey: navMapQueryKey(baseUrl),
    queryFn: () => getNavMap(baseUrl as string),
    enabled: baseUrl !== undefined,
  });
}

export function useCrawlNavMap() {
  const queryClient = useQueryClient();
  return useMutation<NavMapDisplay, Error, string>({
    mutationFn: crawlNavMap,
    onSuccess: (data, baseUrl) => {
      queryClient.setQueryData(navMapQueryKey(baseUrl), data);
    },
  });
}

export function useDeleteNavMap() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: deleteNavMap,
    onSuccess: (_data, baseUrl) => {
      queryClient.setQueryData(navMapQueryKey(baseUrl), null);
    },
  });
}
