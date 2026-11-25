import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export type AgyEngine = "muse" | "agy" | "gemini-web";

export type AgyModelOption = {
  id: string;
  label: string;
};

export type AgyWizardStep = {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  detail?: string;
};

export type AgyDeployJob = {
  id: number;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  output: string;
  message: string;
  steps: AgyWizardStep[];
};

export type AgyStatus = {
  installed: boolean;
  binPath: string | null;
  version: string | null;
  loggedIn: boolean;
  enabled: boolean;
  model: string;
  ready: boolean;
  models: AgyModelOption[];
  nodeEngines: Record<string, AgyEngine>;
  job: AgyDeployJob | null;
  lastError: string | null;
  checkedAt: number;
};

export function formatAgyModelShortName(
  modelId: string,
  models?: AgyModelOption[],
  explicitLabel?: string,
): string {
  const matched = models?.find((m) => m.id === modelId)?.label;
  const raw = (matched || explicitLabel || modelId || "").trim();
  if (!raw) return "AGY";
  return raw.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)\s*$/i, "").trim();
}

export function resolveEffectiveAgyEngine(
  ready: boolean,
  nodeEngines: Record<string, AgyEngine> | undefined,
  nodeId: string,
  defaultEngine: AgyEngine = "muse",
  geminiWebReady = false,
): AgyEngine {
  const fallback: AgyEngine =
    defaultEngine === "agy"
      ? ready
        ? "agy"
        : "muse"
      : defaultEngine === "gemini-web"
        ? geminiWebReady
          ? "gemini-web"
          : "muse"
        : "muse";
  const explicit = nodeEngines?.[nodeId];
  if (explicit === "gemini-web") {
    return geminiWebReady ? "gemini-web" : fallback;
  }
  if (explicit === "agy") {
    return ready ? "agy" : "muse";
  }
  if (explicit === "muse") return "muse";
  return fallback;
}

export async function fetchAgyStatus(refresh = false): Promise<AgyStatus> {
  const res = await fetch(refresh ? "/agy/status?refresh=1" : "/agy/status");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as AgyStatus;
}

export function useAgyStatus() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["agy-status"],
    queryFn: () => fetchAgyStatus(false),
    staleTime: 10_000,
    refetchInterval: (q) =>
      q.state.data?.job?.status === "running" ? 1500 : false,
  });

  const status = query.data ?? null;
  const ready = Boolean(status?.ready);
  const shortModelName = formatAgyModelShortName(
    status?.model ?? "",
    status?.models,
  );

  const refresh = useCallback(
    async (force = false) => {
      if (force) {
        const fresh = await fetchAgyStatus(true);
        queryClient.setQueryData(["agy-status"], fresh);
        return fresh;
      }
      await queryClient.invalidateQueries({ queryKey: ["agy-status"] });
      return queryClient.getQueryData<AgyStatus>(["agy-status"]) ?? null;
    },
    [queryClient],
  );

  const effectiveEngineFor = useCallback(
    (
      nodeId: string,
      defaultEngine: AgyEngine = "muse",
      geminiWebReady = false,
    ): AgyEngine =>
      resolveEffectiveAgyEngine(
        ready,
        status?.nodeEngines,
        nodeId,
        defaultEngine,
        geminiWebReady,
      ),
    [ready, status?.nodeEngines],
  );

  const setNodeEngine = useCallback(
    async (nodeId: string, engine: AgyEngine) => {
      queryClient.setQueryData<AgyStatus | undefined>(["agy-status"], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          nodeEngines: { ...prev.nodeEngines, [nodeId]: engine },
        };
      });
      const res = await fetch("/agy/node-engine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId, engine }),
      });
      if (!res.ok) {
        await queryClient.invalidateQueries({ queryKey: ["agy-status"] });
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "切换通道失败");
      }
      const data = (await res.json()) as {
        nodeEngines?: Record<string, AgyEngine>;
      };
      if (data.nodeEngines) {
        queryClient.setQueryData<AgyStatus | undefined>(["agy-status"], (prev) =>
          prev ? { ...prev, nodeEngines: data.nodeEngines! } : prev,
        );
      }
    },
    [queryClient],
  );

  return {
    status,
    ready,
    shortModelName,
    isLoading: query.isPending,
    refresh,
    effectiveEngineFor,
    setNodeEngine,
  };
}
