// [yoyo-local] 本地 ctx 装配：把宿主注入的 ctx 换成本地实现。
//
//   db               → drizzle-orm/bun-sqlite 实例（local/db.ts）//   blobs            → ./data/blobs/ 目录实现（local/blobs.ts）//   executePrivileged → 直调 server/src/privileged.ts 的 Handlers
//                      （node:fs / child_process 原生实现），入参出参
//                      过契约自带 zod 校验，与平台口径一致
//   agent.spawnTask  → 写本地桥任务表（bridge-jobs.ts），不派真任务；
//                      返回 taskId = jobId，分发代码据此把节点标 working + genTaskId，节点稳定停在等待态
//   inference.complete / tool.generate_media
//                    → 抛 BridgeQueuedError，三个调用点定点捕获后//                      落桥任务（见 generation-dispatch / tool-dispatch
//                      见 [yoyo-local] 适配。
//   invalidateQueries / emit → 本地 no-op（单机单客户端；客户端自动靠 mutation 失效与队列轮询覆盖刷新）

import type {
  Ctx,
  PrivilegedContract,
  PrivilegedHandler,
  SpaceDbAccessor,
} from "@hatch/space-sdk";
import { eq } from "drizzle-orm";
import { Handlers } from "../server/src/privileged";
import * as schema from "../server/src/schema";
import {
  BridgeQueuedError,
  createBridgeJob,
  ensureBridgeJobsTable,
  getBridgeJob,
} from "../server/src/actions/bridge-jobs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "../server/src/actions/contracts";
import { createBlobClient } from "./blobs";
import { DATA_DIR, PROJECTS_DIR } from "./config";
import type { LocalDb } from "./db";
import {
  cancelAgyTask,
  copyNodeEngine,
  generateImageWithAgy,
  getAgyStatus,
  getNodeEngine,
  registerAgyTask,
  runAgyPrompt,
  setNodeEngine,
} from "./agy";
import {
  cancelGeminiWebTask,
  generateImageWithGeminiWeb,
  getGeminiWebStatus,
  registerGeminiWebTask,
} from "./gemini-web";

const handlerByName = Handlers as unknown as Record<
  string,
  PrivilegedHandler | undefined
>;

const KIND_BY_EXPECTS_ACTION: Record<string, string> = {
  completeImageGeneration: "task-image",
  completeVideoGeneration: "task-video",
  completeAudioGeneration: "task-audio",
};

function nodeIdFromMessage(message: string): string | null {
  const match = message.match(/nodeId（原样回传，不要改动）：(\S+)/);
  return match?.[1] ?? null;
}

// [yoyo-local · 第三步契约扩展] spawnTask 报文结构化解析。
//
// 任务通道的本地任务原本只有 { message }：报文里的 nodeId 与本地// 文件路径在云端无意义，云端桥无法据此重建生成。报文格式由同仓
// generation-dispatch 的三条 spawn 路径定版（生成要求/视频提示

// 音频内容要求 + 画幅比例 brief + 目标时长 + 参考文件行），这里在报文产生的同一侧把它解析回结构化字段存进 payload.parsed，云端// 桥据此在影子项目重建等价生成。message 原文保留，解析失败字段为
// null（云端遇到不可解析的任务会显式失败，不静默丢内容）。
// relPath 在本地侧算（本地最清楚 PROJECTS_DIR 的真实位置）：参考文件相对项目根的路径，供云端经 /bridge/files/<relPath> 拉取；文件不在项目根内时为 null。------------------------------------------------------------------------

export type ParsedSpawnRef = {
  kind: "image" | "video" | "audio";
  title: string;
  path: string;
  relPath: string | null;
};

export type ParsedSpawnMessage = {
  prompt: string | null;
  ratio: string | null;
  durationSeconds: number | null;
  refs: ParsedSpawnRef[];
};

function relToProjectsDir(path: string): string | null {
  const rel = relative(PROJECTS_DIR, resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

const PROMPT_END_MARKERS = [
  "\n画幅比例",
  "\n目标时长",
  "\n必须使用下面这些本地图片文件作为参考图",
  "\n可参考下面这些本地文",
  "\n注意：另",
  "\n项目工作目录",
  "\n图片保存",
  "\n成片保存",
  "\n音频保存",
  "\n要求",
];

export function parseSpawnMessage(message: string): ParsedSpawnMessage {
  let prompt: string | null = null;
  const label = message.match(/(?:生成要求|视频提示词|音频内容要求)：/);
  if (label?.index !== undefined) {
    const start = label.index + label[0].length;
    let end = message.length;
    for (const marker of PROMPT_END_MARKERS) {
      const at = message.indexOf(marker, start);
      if (at !== -1 && at < end) end = at;
    }
    prompt = message.slice(start, end).trim() || null;
  }
  const ratio = message.match(/画幅比例：([^，]+)/)?.[1] ?? null;
  const durationMatch = message.match(/目标时长：约\s*(\d+)\s*秒/);
  const refs: ParsedSpawnRef[] = [];
  for (const line of message.split("\n")) {
    const numbered = line.match(/^参考图\s*\d+（(.*)）：(.+)$/);
    if (numbered?.[1] !== undefined && numbered[2] !== undefined) {
      const path = numbered[2].trim();
      refs.push({
        kind: "image",
        title: numbered[1],
        path,
        relPath: relToProjectsDir(path),
      });
      continue;
    }
    const typed = line.match(/^参考(图片|视频|音频)（(.*)）：(.+)$/);
    if (typed?.[1] !== undefined && typed[2] !== undefined && typed[3] !== undefined) {
      const path = typed[3].trim();
      refs.push({
        kind: typed[1] === "图片" ? "image" : typed[1] === "视频" ? "video" : "audio",
        title: typed[2],
        path,
        relPath: relToProjectsDir(path),
      });
    }
  }
  return {
    prompt,
    ratio,
    durationSeconds: durationMatch ? Number(durationMatch[1]) : null,
    refs,
  };
}

export function createCtx(db: LocalDb): Ctx {
  const dbAccessor = (() => db) as unknown as SpaceDbAccessor;
  const businessDb = db as unknown as Db;

  const ctx: Ctx = {
    slug: "yoyo-local",
    invocationId: crypto.randomUUID(),
    spaceDir: DATA_DIR,
    db: dbAccessor,
    viewer: { source: "local", authenticated: true },
    blobs: createBlobClient(),

    executePrivileged: (async (contract: PrivilegedContract, args: unknown) => {
      const handler = handlerByName[contract.name];
      if (!handler) {
        throw new Error(`本地特权层未实现契约：${contract.name}`);
      }
      const parsedArgs = contract.request.parse(args);
      const result = await handler(parsedArgs as never);
      return contract.response.parse(result);
    }) as Ctx["executePrivileged"],

    agent: {
      async spawnTask(message, options) {
        await ensureBridgeJobsTable(businessDb);
        const expectsAction = options?.expectsAction ?? null;
        const nodeId = nodeIdFromMessage(message);
        const nodeRow = nodeId
          ? (
              await businessDb
                .select({ projectId: schema.canvasNodes.projectId })
                .from(schema.canvasNodes)
                .where(eq(schema.canvasNodes.id, nodeId))
            )[0]
          : undefined;
        const job = await createBridgeJob(businessDb, {
          kind: (expectsAction && KIND_BY_EXPECTS_ACTION[expectsAction]) || "task",
          projectId: nodeRow?.projectId ?? null,
          nodeId,
          expectsAction,
          dedupeKey: options?.dedupeKey ?? null,
          payload: { message, parsed: parseSpawnMessage(message) },
        });
        return {
          ok: true as const,
          taskId: job.jobId,
          agentId: "local-bridge",
          messageId: job.jobId,
        };
      },
      async send(message, options) {
        return this.spawnTask(message, options);
      },
      async status(taskId) {
        const job = await getBridgeJob(businessDb, taskId).catch(() => null);
        if (!job) return { taskId, status: "not_found" as const };
        const status =
          job.status === "queued"
            ? ("queued" as const)
            : job.status === "claimed"
              ? ("running" as const)
              : job.status === "done"
                ? ("completed" as const)
                : ("failed" as const);
        return { taskId, status, agentId: "local-bridge", messageId: taskId };
      },
    },

    inference: {
      async complete() {
        throw new BridgeQueuedError("inference");
      },
    },

    tool: {
      async generate_media() {
        throw new BridgeQueuedError("generate_media");
      },
    },

    localAgy: {
      async isReady() {
        return (await getAgyStatus(false)).ready;
      },
      getNodeEngine,
      setNodeEngine,
      copyNodeEngine,
      startTask(runner) {
        return registerAgyTask((signal) => runner({ signal }));
      },
      cancelTask: cancelAgyTask,
      generateImage: generateImageWithAgy,
      async completeText(opts) {
        const prompt = opts.system
          ? `系统要求：${opts.system}

${opts.prompt}`
          : opts.prompt;
        const res = await runAgyPrompt({
          prompt,
          addDirs: opts.addDirs,
          jsonSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          timeoutMs: opts.timeoutMs ?? 120_000,
          signal: opts.signal,
        });
        const structured = res.structuredOutput as { text?: unknown } | null;
        const text =
          structured && typeof structured.text === "string" && structured.text.trim()
            ? structured.text.trim()
            : res.response.trim();
        if (!text) throw new Error("AGY CLI 未返回有效文本内容");
        return { text };
      },
    },

    localGeminiWeb: {
      async isReady() {
        return (await getGeminiWebStatus(false)).ready;
      },
      startTask(runner) {
        return registerGeminiWebTask((signal) => runner({ signal }));
      },
      cancelTask: cancelGeminiWebTask,
      generateImage: generateImageWithGeminiWeb,
    },

    emit() {},
    invalidateQueries() {},
  };
  return ctx;
}
