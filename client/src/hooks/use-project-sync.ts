import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { NARROW_BREAKPOINT_PX } from "../device";
import type { CanvasEdge, CanvasNode } from "../types";
import type { Viewport } from "./gesture-math";

export function useDismissOnOutside(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, open, ref]);
}

export function useProjectSync(opts: {
  projectId: string | null;
  setProjectId: (id: string | null) => void;
  canvasRef: RefObject<HTMLDivElement | null>;
  loadedProjectRef: MutableRefObject<string | null>;
  intentionalEmptyRef: MutableRefObject<boolean>;
  knownNodeIdsRef: MutableRefObject<Set<string>>;
  nodesRef: MutableRefObject<CanvasNode[]>;
  edgesRef: MutableRefObject<CanvasEdge[]>;
  viewportRef: MutableRefObject<Viewport>;
  selectedIdsRef: MutableRefObject<Set<string>>;
  selectedEdgeIdRef: MutableRefObject<string | null>;
  setNodes: Dispatch<SetStateAction<CanvasNode[]>>;
  setEdges: Dispatch<SetStateAction<CanvasEdge[]>>;
  setViewport: Dispatch<SetStateAction<Viewport>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectedEdgeId: Dispatch<SetStateAction<string | null>>;
  setHoveredId: Dispatch<SetStateAction<string | null>>;
  setCanvasSize: Dispatch<SetStateAction<{ width: number; height: number }>>;
}) {
  const {
    projectId,
    setProjectId,
    canvasRef,
    loadedProjectRef,
    intentionalEmptyRef,
    knownNodeIdsRef,
    nodesRef,
    edgesRef,
    viewportRef,
    selectedIdsRef,
    selectedEdgeIdRef,
    setNodes,
    setEdges,
    setViewport,
    setSelectedIds,
    setSelectedEdgeId,
    setHoveredId,
    setCanvasSize,
  } = opts;

  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects({}),
    refetchInterval: 5000,
  });

  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject({ id: projectId ?? "" }),
    enabled: projectId !== null,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (projectId === null && projectsQ.data?.projects[0]) {
      setProjectId(projectsQ.data.projects[0].id);
    }
  }, [projectsQ.data, projectId, setProjectId]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setCanvasSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasRef, setCanvasSize]);

  useEffect(() => {
    const data = projectQ.data;
    if (!data?.project || data.project.id !== projectId) return;
    if (loadedProjectRef.current === projectId) return;
    loadedProjectRef.current = projectId;
    intentionalEmptyRef.current = data.nodes.length === 0;
    knownNodeIdsRef.current = new Set(data.nodes.map((n) => n.id));
    nodesRef.current = data.nodes;
    setNodes(data.nodes);
    edgesRef.current = data.edges;
    setEdges(data.edges);
    viewportRef.current = data.project.viewport;
    setViewport(data.project.viewport);
    selectedIdsRef.current = new Set();
    setSelectedIds(new Set());
    selectedEdgeIdRef.current = null;
    setSelectedEdgeId(null);
    setHoveredId(null);
    const visible = data.nodes.filter((n) => !n.hidden);
    if (window.innerWidth < NARROW_BREAKPOINT_PX && visible.length > 0) {
      requestAnimationFrame(() => {
        const el = canvasRef.current;
        if (!el || loadedProjectRef.current !== projectId) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const minX = Math.min(...visible.map((n) => n.x));
        const minY = Math.min(...visible.map((n) => n.y));
        const maxX = Math.max(...visible.map((n) => n.x + n.width));
        const maxY = Math.max(...visible.map((n) => n.y + n.height));
        const pad = 16;
        const zoom = Math.min(
          1,
          (rect.width - pad * 2) / Math.max(1, maxX - minX),
          (rect.height - pad * 2) / Math.max(1, maxY - minY),
        );
        const fitted: Viewport = {
          zoom,
          x: pad - minX * zoom + (rect.width - pad * 2 - (maxX - minX) * zoom) / 2,
          y: pad - minY * zoom + (rect.height - pad * 2 - (maxY - minY) * zoom) / 2,
        };
        viewportRef.current = fitted;
        setViewport(fitted);
      });
    }
  }, [
    canvasRef,
    edgesRef,
    intentionalEmptyRef,
    knownNodeIdsRef,
    loadedProjectRef,
    nodesRef,
    projectId,
    projectQ.data,
    selectedEdgeIdRef,
    selectedIdsRef,
    setEdges,
    setHoveredId,
    setNodes,
    setSelectedEdgeId,
    setSelectedIds,
    setViewport,
    viewportRef,
  ]);

  return { projectsQ, projectQ };
}
