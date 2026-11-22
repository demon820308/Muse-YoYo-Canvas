// projects.ts — 项目注册（列表/创建/工作区/改名/删除/读取）。批次 S2 自 server/src/actions.ts
// 注册段整段搬移：注册名、契约形状与 handler 行为不变，纯结构搬移。

import { defineAction, z } from "@hatch/space-sdk";
import { Contracts } from "@space/privileged";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "../schema";
import { isWindows, normalizePathForCompare } from "../platform";
import { edgeShape, nodeShape, okResponse, toEdge, toNode } from "./contracts";
import { getProjectRow } from "./graph-helpers";
import { projectDirName, projectDirBase, projectWorkspaceDir, expandHome } from "./project-dirs";

function rewritePathPrefix(
  filePath: string | null,
  oldDir: string,
  newDir: string,
  win = isWindows(),
): string | null {
  if (!filePath) return filePath;
  const expanded = expandHome(filePath);
  const normFile = expanded.replace(/[\\/]+/g, "/");
  const normOld = oldDir.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const normNew = newDir.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const cmpFile = normalizePathForCompare(normFile, win);
  const cmpOld = normalizePathForCompare(normOld, win);
  const matchPrefix = cmpFile === cmpOld || cmpFile.startsWith(`${cmpOld}/`);
  if (!matchPrefix) return filePath;
  const rest = normFile.slice(normOld.length);
  const sep = newDir.includes("\\") ? "\\" : "/";
  return `${normNew}${rest}`.replace(/\//g, sep);
}

export const ProjectsActions = {
  listProjects: defineAction({
    description:
      "Lists this space's canvas projects with node counts and working directories, most recently active first.",
    request: z.object({}),
    response: z.object({
      projects: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          nodeCount: z.number(),
          workspaceDir: z.string(),
          updatedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projects)
        .orderBy(desc(schema.projects.updatedAt));
      const nodeRows = await db
        .select({
          projectId: schema.canvasNodes.projectId,
          id: schema.canvasNodes.id,
        })
        .from(schema.canvasNodes);
      const counts = new Map<string, number>();
      for (const n of nodeRows) {
        counts.set(n.projectId, (counts.get(n.projectId) ?? 0) + 1);
      }
      return {
        projects: rows.map((p) => ({
          id: p.id,
          name: p.name,
          nodeCount: counts.get(p.id) ?? 0,
          workspaceDir: p.workspaceDir,
          updatedAt: p.updatedAt.toISOString(),
        })),
      };
    },
  }),

  pickProjectDirectory: defineAction({
    description:
      "Opens a native folder picker dialog on desktop and returns the chosen path, or null if cancelled/unavailable.",
    request: z.object({}),
    response: z.object({ path: z.string().nullable() }),
    privileged: [Contracts.pickDirectory],
    async handler(ctx) {
      return await ctx.executePrivileged(Contracts.pickDirectory, {});
    },
  }),

  createProject: defineAction({
    description:
      "Creates a new empty canvas project and its dedicated working directory under ~/workspace/yoyo-canvas-projects/<name>-<id8> (or a user-selected workspaceDir). The project is usable immediately — there is no binding or setup state.",
    request: z.object({
      name: z.string().min(1).max(80),
      workspaceDir: z.string().max(500).optional(),
    }),
    response: z.object({
      id: z.string(),
      workspaceDir: z.string(),
    }),
    privileged: [Contracts.ensureProjectDir],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const id = crypto.randomUUID();
      const dirName = projectDirName(args.name, id);
      const customDir = args.workspaceDir?.trim() || undefined;
      let workspaceDir = customDir ?? projectWorkspaceDir(dirName);
      try {
        const ensured = await ctx.executePrivileged(Contracts.ensureProjectDir, {
          dirName,
          customDir,
        });
        workspaceDir = ensured.path;
      } catch (err) {
        if (customDir) {
          throw err;
        }
        // Directory creation is retriable later via
        // ensureProjectWorkspace.
      }
      await db.insert(schema.projects).values({
        id,
        name: args.name,
        workspaceDir,
      });
      ctx.invalidateQueries();
      return {
        id,
        workspaceDir,
      };
    },
  }),

  ensureProjectWorkspace: defineAction({
    description:
      "Creates (if needed) the working directory for an existing project and returns its absolute path.",
    request: z.object({ projectId: z.string() }),
    response: z.object({ workspaceDir: z.string() }),
    privileged: [Contracts.ensureProjectDir],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const project = await getProjectRow(db, args.projectId);
      if (!project) throw new Error("ensureProjectWorkspace: project not found");
      const ensured = await ctx.executePrivileged(Contracts.ensureProjectDir, {
        dirName: projectDirBase(project),
      });
      if (ensured.path !== project.workspaceDir) {
        await db
          .update(schema.projects)
          .set({ workspaceDir: ensured.path, updatedAt: new Date() })
          .where(eq(schema.projects.id, project.id));
      }
      ctx.invalidateQueries();
      return { workspaceDir: ensured.path };
    },
  }),

  renameProject: defineAction({
    description: "Renames one canvas project.",
    request: z.object({ id: z.string(), name: z.string().min(1).max(80) }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.projects)
        .set({ name: args.name, updatedAt: new Date() })
        .where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  changeProjectDirectory: defineAction({
    description:
      "Moves a project's working directory to a new location, copies all existing project files over, and rewrites filePath references across canvas_nodes, assets, and generation_records.",
    request: z.object({
      projectId: z.string(),
      workspaceDir: z.string().min(1).max(500),
    }),
    response: z.object({
      workspaceDir: z.string(),
      movedFiles: z.number(),
      cleanupWarning: z.string().nullable(),
    }),
    privileged: [Contracts.moveProjectDir],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const project = await getProjectRow(db, args.projectId);
      if (!project) throw new Error("项目不存在");
      const nodeRows = await db
        .select()
        .from(schema.canvasNodes)
        .where(eq(schema.canvasNodes.projectId, args.projectId));
      if (
        nodeRows.some(
          (n) => n.genStatus === "queued" || n.genStatus === "working",
        )
      ) {
        throw new Error("当前项目有正在生成或排队中的任务，请等待完成后再更改目录");
      }
      const oldDir = expandHome(project.workspaceDir);
      const defaultDir = projectWorkspaceDir(
        projectDirName(project.name, project.id),
      );
      const extraDirs = [defaultDir].filter(
        (d) => d.toLowerCase() !== oldDir.toLowerCase(),
      );
      const moved = await ctx.executePrivileged(Contracts.moveProjectDir, {
        fromDir: oldDir,
        toDir: args.workspaceDir.trim(),
        extraDirs,
      });
      const newDir = moved.path;
      const now = new Date();
      await db
        .update(schema.projects)
        .set({ workspaceDir: newDir, updatedAt: now })
        .where(eq(schema.projects.id, args.projectId));

      const rewriteAnyOld = (p: string | null) => {
        for (const srcDir of [oldDir, ...extraDirs]) {
          const next = rewritePathPrefix(p, srcDir, newDir);
          if (next !== p) return next;
        }
        return p;
      };

      for (const n of nodeRows) {
        const nextPath = rewriteAnyOld(n.filePath);
        if (nextPath !== n.filePath) {
          await db
            .update(schema.canvasNodes)
            .set({ filePath: nextPath, updatedAt: now })
            .where(eq(schema.canvasNodes.id, n.id));
        }
      }

      const assetRows = await db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.projectId, args.projectId));
      for (const a of assetRows) {
        const nextPath = rewriteAnyOld(a.filePath);
        if (nextPath !== a.filePath) {
          await db
            .update(schema.assets)
            .set({ filePath: nextPath })
            .where(eq(schema.assets.id, a.id));
        }
      }

      const recordRows = await db
        .select()
        .from(schema.generationRecords)
        .where(eq(schema.generationRecords.projectId, args.projectId));
      for (const r of recordRows) {
        const nextPath = rewriteAnyOld(r.filePath);
        if (nextPath !== r.filePath) {
          await db
            .update(schema.generationRecords)
            .set({ filePath: nextPath })
            .where(eq(schema.generationRecords.id, r.id));
        }
      }

      ctx.invalidateQueries();
      return {
        workspaceDir: newDir,
        movedFiles: moved.movedFiles,
        cleanupWarning: moved.cleanupWarning,
      };
    },
  }),

  deleteProject: defineAction({
    description: "Deletes one canvas project together with all of its nodes and edges.",
    request: z.object({ id: z.string() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db.batch([
        db
          .delete(schema.canvasNodes)
          .where(eq(schema.canvasNodes.projectId, args.id)),
        db
          .delete(schema.canvasEdges)
          .where(eq(schema.canvasEdges.projectId, args.id)),
        db.delete(schema.projects).where(eq(schema.projects.id, args.id)),
      ]);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getProject: defineAction({
    description:
      "Returns one project with its saved viewport, working directory, and full node graph, or a null project when the id is unknown.",
    request: z.object({ id: z.string() }),
    response: z.object({
      project: z
        .object({
          id: z.string(),
          name: z.string(),
          workspaceDir: z.string(),
          viewport: z.object({
            x: z.number(),
            y: z.number(),
            zoom: z.number(),
          }),
        })
        .nullable(),
      nodes: z.array(nodeShape),
      edges: z.array(edgeShape),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const projectRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, args.id))
        .limit(1);
      const project = projectRows[0];
      if (!project) return { project: null, nodes: [], edges: [] };
      const nodeRows = await db
        .select()
        .from(schema.canvasNodes)
        .where(eq(schema.canvasNodes.projectId, args.id))
        .orderBy(asc(schema.canvasNodes.sortOrder), asc(schema.canvasNodes.createdAt));
      const edgeRows = await db
        .select()
        .from(schema.canvasEdges)
        .where(eq(schema.canvasEdges.projectId, args.id))
        .orderBy(asc(schema.canvasEdges.sortOrder), asc(schema.canvasEdges.createdAt));
      const nodes: z.infer<typeof nodeShape>[] = [];
      for (const row of nodeRows) nodes.push(await toNode(ctx, row));
      return {
        project: {
          id: project.id,
          name: project.name,
          workspaceDir: project.workspaceDir,
          viewport: {
            x: project.viewportX,
            y: project.viewportY,
            zoom: project.viewportZoom,
          },
        },
        nodes,
        edges: edgeRows.map(toEdge),
      };
    },
  }),
};