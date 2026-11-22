// bridge-transport.ts — 桥的出站单点封装：与本地画布后端（经
// Cloudflare 隧道）的全部 HTTP 往来只许从这里出。fetch 为主；下载
// 按 Range 分段、上传按探针定版 ≤10MB/段分块协议，两向分段失败都
// 可重试。错误分类只有三种出口：网络层失败/超时与本地未配对 →
// BridgeUnreachableError；令牌被拒 (401) → BridgeAuthError；其余
// 对端错误 → 普通 Error 带对端信息。（自 YoYo画布 Space 同名模块
// 移植，契约不变。）

export class BridgeUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnreachableError";
  }
}

export class BridgeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeAuthError";
  }
}

export type BridgePendingJob = {
  jobId: string;
  kind: string;
  status: string;
  projectId: string | null;
  nodeId: string | null;
  expectsAction: string | null;
  payload: unknown;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BridgeResultReply = { status: string; error: string | null };

type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const SEGMENT_RETRIES = 2;

/** baseUrl 归一：去尾斜杠、无 scheme 时补 https://。 */
export function normalizeBridgeBaseUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");
  if (value && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    value = `https://${value}`;
  }
  return value;
}

export function createBridgeTransport(opts: {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
  chunkSize?: number;
}) {
  const baseUrl = normalizeBridgeBaseUrl(opts.baseUrl);
  const chunkSize =
    opts.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : 10 * 1024 * 1024;
  const doFetch: FetchImpl =
    opts.fetchImpl ?? ((input, init) => fetch(input, init));

  /** One raw request with the bridge token attached and the error
   * classification applied. Returns the Response for any status the
   * caller is expected to interpret (200/206/409/422/...). */
  async function rawRequest(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          "x-bridge-token": opts.token,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BridgeUnreachableError(
        `本地桥不可达：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 401) {
      throw new BridgeAuthError("桥令牌被本地拒绝（401）：请在桥设置里核对令牌");
    }
    if (res.status === 503) {
      const text = await res.text().catch(() => "");
      if (text.includes("bridge_not_configured")) {
        throw new BridgeUnreachableError(
          "本地画布尚未配置桥令牌（未配对），按不可达处理",
        );
      }
      throw new Error(`本地桥返回 503：${text.slice(0, 200)}`);
    }
    return res;
  }

  /** Retries one segment-sized operation: network-layer failures get
   * SEGMENT_RETRIES extra attempts; auth errors are never retried. */
  async function withSegmentRetries<T>(run: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt += 1) {
      try {
        return await run();
      } catch (err) {
        if (err instanceof BridgeAuthError) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  async function readJson(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    if (!text) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  function resultReply(body: Record<string, unknown>): BridgeResultReply {
    return {
      status: typeof body.status === "string" ? body.status : "unknown",
      error: typeof body.error === "string" ? body.error : null,
    };
  }

  return {
    baseUrl,

    async getPending(): Promise<BridgePendingJob[]> {
      const res = await rawRequest("/bridge/pending", { method: "GET" });
      if (!res.ok) {
        throw new Error(`本地桥 /bridge/pending 返回 ${res.status}`);
      }
      const body = await readJson(res);
      const jobs = Array.isArray(body.jobs) ? body.jobs : [];
      return jobs
        .filter(
          (j): j is Record<string, unknown> =>
            !!j && typeof j === "object" && typeof (j as { jobId?: unknown }).jobId === "string",
        )
        .map((j) => ({
          jobId: j.jobId as string,
          kind: typeof j.kind === "string" ? j.kind : "",
          status: typeof j.status === "string" ? j.status : "",
          projectId: typeof j.projectId === "string" ? j.projectId : null,
          nodeId: typeof j.nodeId === "string" ? j.nodeId : null,
          expectsAction:
            typeof j.expectsAction === "string" ? j.expectsAction : null,
          payload: j.payload ?? null,
          error: typeof j.error === "string" ? j.error : null,
          createdAt: typeof j.createdAt === "string" ? j.createdAt : null,
          updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
        }));
    },

    /** Range-segmented download. A peer that ignores Range answers
     * the first request with 200 and the whole body — accepted as the
     * complete file (256MB cap). 206 segments are stitched by their
     * Content-Range until the announced total is covered. */
    async downloadFile(relPath: string): Promise<Uint8Array> {
      const encoded = relPath
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      const parts: Uint8Array[] = [];
      let offset = 0;
      let total: number | null = null;
      for (;;) {
        const end = offset + chunkSize - 1;
        const res = await withSegmentRetries(() =>
          rawRequest(`/bridge/files/${encoded}`, {
            method: "GET",
            headers: { Range: `bytes=${offset}-${end}` },
          }),
        );
        if (res.status === 200) {
          const body = new Uint8Array(await res.arrayBuffer());
          if (body.byteLength > MAX_DOWNLOAD_BYTES) {
            throw new Error("参考文件超过 256MB 上限，已放弃下载");
          }
          return body;
        }
        if (res.status !== 206) {
          throw new Error(`本地桥文件下载返回 ${res.status}（${relPath}）`);
        }
        const range = res.headers.get("content-range") ?? "";
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range.trim());
        if (!match) {
          throw new Error(`本地桥文件下载缺少合法 Content-Range（${relPath}）`);
        }
        const segStart = Number(match[1]);
        const segEnd = Number(match[2]);
        total = Number(match[3]);
        if (segStart !== offset || segEnd < segStart) {
          throw new Error(`本地桥文件分段错位（${relPath}）`);
        }
        if (total > MAX_DOWNLOAD_BYTES) {
          throw new Error("参考文件超过 256MB 上限，已放弃下载");
        }
        const body = new Uint8Array(await res.arrayBuffer());
        parts.push(body);
        offset = segEnd + 1;
        if (offset >= total) break;
      }
      const out = new Uint8Array(total ?? 0);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
      }
      return out;
    },

    async ackClaim(jobId: string): Promise<BridgeResultReply> {
      const res = await rawRequest("/bridge/ack-claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      if (!res.ok) {
        throw new Error(`本地桥 ack-claim 返回 ${res.status}`);
      }
      return resultReply(await readJson(res));
    },

    async postResultText(jobId: string, text: string): Promise<BridgeResultReply> {
      const res = await rawRequest("/bridge/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, text }),
      });
      const body = await readJson(res);
      if (!res.ok && typeof body.status !== "string") {
        throw new Error(`本地桥 result 返回 ${res.status}`);
      }
      return resultReply(body);
    },

    /** Chunked media delivery (probe-settled protocol: every file,
     * even a single-segment one, goes through the chunk headers with
     * total ≥ 1). A segment failure retries that segment; resending
     * from segment 0 is always safe because the peer answers
     * duplicate for segments it already holds. The final segment's
     * reply — including a 422 {status:"failed"} — is returned, not
     * thrown. */
    async postResultMedia(
      jobId: string,
      file: {
        fileName: string;
        title?: string | null;
        contentType: string;
        bytes: Uint8Array;
      },
    ): Promise<BridgeResultReply> {
      const total = Math.max(1, Math.ceil(file.bytes.byteLength / chunkSize));
      let last: BridgeResultReply = { status: "unknown", error: null };
      for (let index = 0; index < total; index += 1) {
        const segment = file.bytes.subarray(
          index * chunkSize,
          Math.min(file.bytes.byteLength, (index + 1) * chunkSize),
        );
        const reply = await withSegmentRetries(async () => {
          const res = await rawRequest("/bridge/result", {
            method: "POST",
            headers: {
              "content-type": file.contentType,
              "x-job-id": jobId,
              "x-file-name": encodeURIComponent(file.fileName),
              ...(file.title
                ? { "x-title": encodeURIComponent(file.title) }
                : {}),
              "x-chunk-index": String(index),
              "x-chunk-total": String(total),
            },
            body: segment,
          });
          const body = await readJson(res);
          if (!res.ok && res.status !== 422 && typeof body.status !== "string") {
            throw new Error(`本地桥 result 分段 ${index} 返回 ${res.status}`);
          }
          return resultReply(body);
        });
        last = reply;
        if (reply.status === "failed") return reply;
      }
      return last;
    },

    async postFail(jobId: string, error: string): Promise<BridgeResultReply> {
      const res = await rawRequest("/bridge/fail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, error }),
      });
      if (!res.ok) {
        throw new Error(`本地桥 fail 返回 ${res.status}`);
      }
      return resultReply(await readJson(res));
    },
  };
}

export type BridgeTransport = ReturnType<typeof createBridgeTransport>;
