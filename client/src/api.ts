// [yoyo-local] 本地版 API 客户端：普通 fetch 实现（云端版此处用
// @hatch/space-sdk/client 的 createActionClient）。契约不变：
// 类型仍从 server/src/actions 的 Actions 推导，调用形状仍是
// api.<动作名>(args) → Promise<返回值>，失败抛 Error（消息为
// 服务端回的人话 error）。线上协议：POST /actions，
// 请求体 { action, args }，成功回动作返回值本身，失败回
// { error } + 4xx/5xx（见 local/app.ts）。
//
// `import type { Actions }` 只取类型：客户端包不拉任何服务端
// 运行时。verbatimModuleSyntax 下漏写 type 是编译错误。

import type { Actions } from "../../server/src/actions";
import type { z } from "@hatch/space-sdk";

// 与平台 client 的 ActionClient 同口径：参数取 zod 的 input 型
// （带 .default() 的字段在调用侧可省），返回值取 output 型。
type ActionClient<A> = {
  [K in keyof A]: A[K] extends {
    request: infer Req extends z.ZodType;
    response: infer Res extends z.ZodType;
  }
    ? (args: z.input<Req>) => Promise<z.output<Res>>
    : never;
};

async function callAction(action: string, args: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch("/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, args: args ?? {} }),
    });
  } catch {
    throw new Error("连不上本地后端：请确认 YoYo画布本地服务正在运行");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `请求失败（HTTP ${res.status}）`;
    throw new Error(message);
  }
  return body;
}

export const api = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (args: unknown) => callAction(prop, args);
    },
  },
) as ActionClient<typeof Actions>;

// 与云端版同形的便捷类型（组件与 hooks 按此引用）：
//   type Req = ApiRequest<typeof api, "runToolNode">;
export type ApiRequest<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Parameters<C[K]>[0];

export type ApiResponse<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;
