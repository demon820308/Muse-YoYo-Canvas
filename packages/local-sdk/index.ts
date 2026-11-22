// [yoyo-local] 本地垫片（服务端面）：@hatch/space-sdk 在本地工程里的替身。
//
// 只实现 yoyohua-bu 源码实际用到的表面，形状与平台 SDK 的 server-contract / index 类型面对齐（见 PLATFORM-TOUCHPOINTS.md）：
//   - z：转出 zod 本体（源码从 SDK 导 z，本地直接用同版本 zod）；
//   - defineAction：产出带 ACTION_BRAND 的动作定义对象；本地服务
//     （local/server.ts）按名分发，调用前 request.parse、返回前
//     response.parse，与平台运行时的校验口径一致；
//   - definePrivilegedContracts / definePrivilegedHandlers：产出带
//     名字的契约描述符和 handler 表；本地 ctx.executePrivileged
//     按契约名直调 handler（local/ctx.ts 装配）；
//   - Ctx / SpaceDb / BlobClient 等类型：与平台同形，SpaceDb 映射到 drizzle-orm/bun-sqlite 的数据库类型（本地数据层即此组合，
//     源工程特征测试已用同一组合验证）

import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { z } from "zod";

export { z };
export type { ZodType } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Blobs

export type BlobPutData = string | ArrayBuffer | ArrayBufferView | Blob;

export interface BlobPutOptions {
  readonly contentType?: string;
  readonly public?: boolean;
}

export interface BlobUrlOptions {
  readonly expiresInSeconds?: number;
  readonly public?: boolean;
}

export interface BlobMetadata {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly sizeBytes: number;
  readonly etag: string;
  readonly visibility: "private" | "public";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface BlobClient {
  put(key: string, data: BlobPutData, options?: BlobPutOptions): Promise<void>;
  getUrl(key: string, options?: BlobUrlOptions): Promise<string>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<BlobMetadata | null>;
  list(prefix?: string): Promise<BlobMetadata[]>;
}

// Database

// 与平?SDK ?SpaceDb 定义逐字同形（Pick<LibSQLDatabase, ...>）?// 本地运行时由 bun-sqlite 驱动兑现同一表面（local/db.ts 装配?// 缺失?batch 以事务内顺序执行补齐），ctx 装配处做一?unknown 转换?
export type SpaceDb<TSchema extends Record<string, unknown> = Record<string, never>> =
  Pick<
    LibSQLDatabase<TSchema>,
    "select" | "insert" | "update" | "delete" | "run" | "all" | "get" | "batch"
  >;

export type SpaceDbAccessor = <
  TSchema extends Record<string, unknown> = Record<string, never>,
>() => SpaceDb<TSchema>;

// Privileged contracts

export const PRIVILEGED_CONTRACT_BRAND = "@hatch/space-sdk/privileged-contract/v1" as const;
export const PRIVILEGED_HANDLERS_FORMAT = "hatch-space-privileged-handlers-v1" as const;

export interface PrivilegedContract<
  Name extends string = string,
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly __brand: typeof PRIVILEGED_CONTRACT_BRAND;
  readonly name: Name;
  readonly description?: string;
  readonly request: Req;
  readonly response: Res;
  readonly capabilities?: readonly string[];
  readonly timeoutMs?: number;
}

export type PrivilegedContractSpec<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> = {
  readonly description?: string;
  readonly request: Req;
  readonly response: Res;
  readonly capabilities?: readonly string[];
  readonly timeoutMs?: number;
};

export type PrivilegedContractsFor<Specs extends Record<string, PrivilegedContractSpec>> = {
  readonly [Name in keyof Specs & string]: PrivilegedContract<
    Name,
    Specs[Name]["request"],
    Specs[Name]["response"]
  >;
};

export type PrivilegedRequest<C extends PrivilegedContract> = z.infer<C["request"]>;
export type PrivilegedResponse<C extends PrivilegedContract> = z.infer<C["response"]>;

export type PrivilegedHandler<C extends PrivilegedContract = PrivilegedContract> = (
  args: PrivilegedRequest<C>,
) => Promise<PrivilegedResponse<C>> | PrivilegedResponse<C>;

export type PrivilegedHandlersFor<Contracts extends Record<string, PrivilegedContract>> = {
  readonly [Name in keyof Contracts]?: PrivilegedHandler<Contracts[Name]>;
};

export type PrivilegedHandlers = Record<string, PrivilegedHandler>;

export type PrivilegedTransport = <C extends PrivilegedContract>(
  contract: C,
  args: PrivilegedRequest<C>,
) => Promise<unknown>;

export interface PrivilegedExecutor {
  executePrivileged<C extends PrivilegedContract>(
    contract: C,
    args: PrivilegedRequest<C>,
  ): Promise<PrivilegedResponse<C>>;
}

export function definePrivilegedContracts<
  Specs extends Record<string, PrivilegedContractSpec>,
>(specs: Specs): PrivilegedContractsFor<Specs> {
  const out: Record<string, PrivilegedContract> = {};
  for (const [name, spec] of Object.entries(specs)) {
    out[name] = {
      __brand: PRIVILEGED_CONTRACT_BRAND,
      name,
      description: spec.description,
      request: spec.request,
      response: spec.response,
      capabilities: spec.capabilities,
      timeoutMs: spec.timeoutMs,
    };
  }
  return out as PrivilegedContractsFor<Specs>;
}

export function definePrivilegedHandlers<Contracts extends Record<string, PrivilegedContract>>(
  _contracts: Contracts,
  handlers: PrivilegedHandlersFor<Contracts>,
): PrivilegedHandlersFor<Contracts> {
  return handlers;
}

export function createPrivilegedExecutor(
  _declared: readonly PrivilegedContract[] | undefined,
  transport: PrivilegedTransport,
): PrivilegedExecutor {
  return {
    executePrivileged: (contract, args) => transport(contract, args),
  } as PrivilegedExecutor;
}

export function isPrivilegedContract(value: unknown): value is PrivilegedContract {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === PRIVILEGED_CONTRACT_BRAND
  );
}

export function isPrivilegedHandlers(value: unknown): value is PrivilegedHandlers {
  return typeof value === "object" && value !== null;
}

// Viewer (源码仅类型面出现，本地给最小同形定


export type SpaceRole = "owner" | "editor" | "viewer";
export type LocalViewer = { source: "local"; authenticated: true };
export type CloudflareViewer = { source: "cloudflare"; authenticated: boolean };
export type PeerViewer = { source: "peer"; authenticated: boolean };
export type Viewer = LocalViewer | CloudflareViewer | PeerViewer;

// Agent / inference / tools

export interface AgentSendOptions {
  readonly expectsAction?: string;
  readonly dedupeKey?: string;
  readonly allowParallel?: boolean;
}

export type AgentSendResult =
  | { ok: true; taskId: string; agentId: string; messageId: string }
  | { ok: false; error: string };

export interface AgentStatusResult {
  readonly taskId: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "not_found";
  readonly returnContractStatus?: "not_expected" | "pending" | "satisfied" | "unsatisfied";
  readonly agentStatus?: string;
  readonly agentId?: string;
  readonly messageId?: string;
  readonly finalResponse?: string;
  readonly statusMessage?: string;
  readonly failureReason?: string;
  readonly expectedAction?: string;
  readonly completedAction?: string;
}

export type AgentTaskOptions = AgentSendOptions;
export type AgentTaskResult = AgentSendResult;

export interface AgentClient {
  spawnTask(message: string, options?: AgentTaskOptions): Promise<AgentTaskResult>;
  send(message: string, options?: AgentSendOptions): Promise<AgentSendResult>;
  status(taskId: string): Promise<AgentStatusResult>;
}

export interface InferenceImageInput {
  readonly dataBase64: string;
  readonly mimeType?: "image/jpeg" | "image/png";
  readonly filename?: string;
  readonly caption?: string;
}

export interface InferenceCompleteOptions<T extends z.ZodType = z.ZodType> {
  readonly schema: T;
  readonly timeout_secs?: number;
  readonly system?: string;
  readonly images?: readonly InferenceImageInput[];
}

export const INFERENCE_SCHEMA_ERROR_BRAND = "@hatch/space-sdk/InferenceSchemaError/v1" as const;

export class InferenceSchemaError extends Error {
  readonly __brand: typeof INFERENCE_SCHEMA_ERROR_BRAND = INFERENCE_SCHEMA_ERROR_BRAND;
  readonly issues: readonly z.core.$ZodIssue[];
  constructor(issues: readonly z.core.$ZodIssue[]) {
    super("inference output failed schema validation");
    this.name = "InferenceSchemaError";
    this.issues = issues;
  }
  static is(value: unknown): value is InferenceSchemaError {
    return (
      value instanceof InferenceSchemaError ||
      (typeof value === "object" &&
        value !== null &&
        (value as { __brand?: unknown }).__brand === INFERENCE_SCHEMA_ERROR_BRAND)
    );
  }
}

export interface InferenceClient {
  complete<T extends z.ZodType>(
    prompt: string,
    options: InferenceCompleteOptions<T>,
  ): Promise<z.infer<T>>;
}

export type GenerateMediaOrientation = "square" | "landscape" | "portrait";

export interface GenerateMediaOptions {
  readonly orientation?: GenerateMediaOrientation;
  readonly key?: string;
}

export interface GeneratedMedia {
  readonly blobKey: string;
  readonly url: string;
  readonly contentType: string;
  readonly bytes: number;
}

/** 本地只兑现 generate_media（其余 vertical 源码未用，索引签名兜底类型面）。*/
export interface SpaceToolClient {
  generate_media(prompt: string, options?: GenerateMediaOptions): Promise<GeneratedMedia>;
  [key: string]: unknown;
}

// Ctx

export interface PortableCtx extends PrivilegedExecutor {
  readonly slug: string;
  readonly invocationId: string;
  readonly spaceDir: string;
  readonly db: SpaceDbAccessor;
  readonly viewer?: Viewer;
  readonly blobs: BlobClient;
}

export type SpaceQueryKey = readonly JsonValue[];
export interface SpaceQueryInvalidation {
  readonly queryKey: SpaceQueryKey;
}
export interface SpaceQueryInvalidationBatch {
  readonly queryKeys: readonly SpaceQueryKey[];
}
export type SpaceQueryInvalidationInput =
  | SpaceQueryKey
  | SpaceQueryInvalidation
  | SpaceQueryInvalidationBatch;

export interface Ctx extends PortableCtx {
  readonly agent: AgentClient;
  readonly inference: InferenceClient;
  readonly tool: SpaceToolClient;
  emit(data: JsonValue): void;
  invalidateQueries(invalidation?: SpaceQueryInvalidationInput): void;
}

// Actions

export const ACTION_BRAND = "@hatch/space-sdk/action/v1" as const;

export interface ActionDefinition<
  TCtx extends PortableCtx = PortableCtx,
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly __brand: typeof ACTION_BRAND;
  readonly request: Req;
  readonly response: Res;
  readonly description?: string;
  readonly privileged?: readonly PrivilegedContract[];
  readonly handler: (ctx: TCtx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export type ActionFactoryInput<
  TCtx extends PortableCtx,
  Req extends z.ZodType,
  Res extends z.ZodType,
> = {
  request: Req;
  response: Res;
  description?: string;
  privileged?: readonly PrivilegedContract[];
  handler: (ctx: TCtx, args: z.infer<Req>) => Promise<z.infer<Res>>;
};

export type ActionsModuleFor<TCtx extends PortableCtx> = Record<
  string,
  Omit<ActionDefinition<TCtx>, "handler"> & {
    handler: (ctx: TCtx, args: any) => Promise<any>;
  }
>;

export type ActionsModule = ActionsModuleFor<Ctx>;

export type ActionRequest<A extends { request: z.ZodType }> = z.infer<A["request"]>;
export type ActionResponse<A extends { response: z.ZodType }> = z.infer<A["response"]>;

export function defineAction<Req extends z.ZodType, Res extends z.ZodType>(
  spec: ActionFactoryInput<Ctx, Req, Res>,
): ActionDefinition<Ctx, Req, Res> {
  return { ...spec, __brand: ACTION_BRAND };
}

export function createDefineAction<TCtx extends PortableCtx>(): <
  Req extends z.ZodType,
  Res extends z.ZodType,
>(
  spec: ActionFactoryInput<TCtx, Req, Res>,
) => ActionDefinition<TCtx, Req, Res> {
  return (spec) => ({ ...spec, __brand: ACTION_BRAND });
}

export function isAction(value: unknown): value is ActionDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === ACTION_BRAND
  );
}

export function actionDescription(
  definition: Pick<ActionDefinition, "description">,
): string | undefined {
  return definition.description;
}
