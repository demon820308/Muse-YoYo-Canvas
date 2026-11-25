import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export type GeminiWebStatus = {
  browserFound: boolean;
  browserName: string | null;
  browserPath: string | null;
  loggedIn: boolean;
  loginInProgress: boolean;
  enabled: boolean;
  ready: boolean;
  lastError: string | null;
  checkedAt: number;
};

export async function fetchGeminiWebStatus(
  refresh = false,
): Promise<GeminiWebStatus> {
  const res = await fetch(
    refresh ? "/gemini-web/status?refresh=1" : "/gemini-web/status",
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as GeminiWebStatus;
}

export function useGeminiWebStatus() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["gemini-web-status"],
    queryFn: () => fetchGeminiWebStatus(false),
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.loginInProgress ? 2000 : false),
  });

  const status = query.data ?? null;
  const ready = Boolean(status?.ready);

  const refresh = useCallback(
    async (force = false) => {
      if (force) {
        const fresh = await fetchGeminiWebStatus(true);
        queryClient.setQueryData(["gemini-web-status"], fresh);
        return fresh;
      }
      await queryClient.invalidateQueries({ queryKey: ["gemini-web-status"] });
      return (
        queryClient.getQueryData<GeminiWebStatus>(["gemini-web-status"]) ?? null
      );
    },
    [queryClient],
  );

  return {
    status,
    ready,
    isLoading: query.isPending,
    refresh,
  };
}
