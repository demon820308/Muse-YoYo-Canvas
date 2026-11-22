// [yoyo-local] 本地垫片（客户端面）：@hatch/space-sdk/client 在本地工程里的替身。
//
// 源码从该模块取三样东西（见 PLATFORM-TOUCHPOINTS.md 第三节）：
//   - spaceQueryClient（main.tsx）：一个普通的 react-query QueryClient。
//   - fileToBase64 / bytesToBase64：浏览器原生编码，返回形状与平台一致
//     （{ dataBase64, mimeType }）。
//   - ApiRequest / ApiResponse 类型（api.ts 已改用本地定义，此处保留同形
//     导出以备其它引用）。
// createActionClient 一并给出 fetch 实现（POST /actions），与本地
// api.ts 的实现同口径，源码若有别处引用可直接用。

import { QueryClient } from "@tanstack/react-query";

export const spaceQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: 0 },
  },
});

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return bufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export async function fileToBase64(
  file: Blob,
): Promise<{ dataBase64: string; mimeType: string }> {
  const buf = await file.arrayBuffer();
  return {
    dataBase64: bufferToBase64(buf),
    mimeType: file.type || "application/octet-stream",
  };
}

export type ApiRequest<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Parameters<C[K]>[0];

export type ApiResponse<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;

type ClientActionShape = {
  request: import("zod").ZodType;
  response: import("zod").ZodType;
};

export type ActionClient<A extends Record<string, ClientActionShape>> = {
  [K in keyof A]: (
    args: import("zod").z.infer<A[K]["request"]>,
  ) => Promise<import("zod").z.infer<A[K]["response"]>>;
};

/** 与本地 api.ts 相同的 fetch 口径：POST /actions { action, args }。 */
export function createActionClient<A extends Record<string, ClientActionShape>>(
  options?: { endpoint?: string },
): ActionClient<A> {
  const endpoint = options?.endpoint ?? "/actions";
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return async (args: unknown) => {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: prop, args: args ?? {} }),
          });
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | unknown;
          if (!res.ok) {
            const message =
              body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
                ? (body as { error: string }).error
                : `请求失败（HTTP ${res.status}）`;
            throw new Error(message);
          }
          return body;
        };
      },
    },
  ) as ActionClient<A>;
}
