// [yoyo-local] 画布 Agent 后端服务：
//   - 模型配置持久化（data/agent-config.json，Key 脱敏下发）
//   - 三路推理调度：Muse (YoYo桥 kind=text) / OpenAI 兼容端点 / Anthropic 端点
//   - 连接测试（POST /agent/test）
//   - Muse 桥异步轮次管理（POST /agent/chat + GET /agent/turn）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createBridgeJob,
  getBridgeJob,
  settleBridgeJob,
} from "../server/src/actions/bridge-jobs";
import type { Db } from "../server/src/actions/contracts";
import { DATA_DIR } from "./config";
import { readBlobBytes } from "./blobs";
import { effectiveProfiles } from "./bridge-profiles";
import { getAgyStatus, loadAgyConfig, runAgyPrompt, streamAgyChat } from "./agy";

export type AgentProvider = "muse" | "openai" | "anthropic" | "agy";

export type AgentProfile = {
  id: string;
  name: string;
  provider: AgentProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type MaskedAgentProfile = Omit<AgentProfile, "apiKey"> & {
  apiKeyMasked: string;
  hasApiKey: boolean;
  builtin?: boolean;
  ready?: boolean;
  modelLabel?: string;
};

type StoredAgentConfig = {
  activeProfileId: string;
  profiles: AgentProfile[];
};

export type AgentOperation =
  | {
      op: "create_node";
      tempId?: string;
      type:
        | "text"
        | "image"
        | "video"
        | "audio"
        | "config"
        | "sticky-note"
        | "video-frames"
        | "video-relay"
        | "audio-extract"
        | "video-compose"
        | "prompt-reverse";
      title?: string;
      prompt?: string;
      content?: string;
      genRatio?: string;
      genDuration?: number;
      genMode?: "image" | "video" | "audio" | "text";
      nearNodeId?: string;
      x?: number;
      y?: number;
    }
  | {
      op: "insert_asset";
      tempId?: string;
      assetId: string;
      title?: string;
      nearNodeId?: string;
      x?: number;
      y?: number;
    }
  | {
      op: "update_node";
      nodeId: string;
      title?: string;
      prompt?: string;
      content?: string;
      genRatio?: string;
      genDuration?: number;
    }
  | {
      op: "delete_node";
      nodeId: string;
    }
  | {
      op: "connect";
      source: string;
      target: string;
    }
  | {
      op: "disconnect";
      source: string;
      target: string;
    }
  | {
      op: "trigger_generate";
      nodeId: string;
    }
  | {
      op: "group_nodes";
      nodeIds: string[];
      title?: string;
    }
  | {
      op: "save_prompt";
      title: string;
      content: string;
    };

export type AgentParsedResponse = {
  reply: string;
  operations: AgentOperation[];
};

const BUILTIN_MUSE_PROFILE: AgentProfile = {
  id: "muse-bridge",
  name: "Muse Agent (YoYo桥)",
  provider: "muse",
  baseUrl: "",
  apiKey: "",
  model: "muse-bridge",
};

const BUILTIN_AGY_PROFILE: AgentProfile = {
  id: "agy-cli",
  name: "AGY CLI (本地模型)",
  provider: "agy",
  baseUrl: "",
  apiKey: "",
  model: "gemini-3.8-flash-medium",
};

const AGENT_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    operations: {
      type: "array",
      items: { type: "object" },
    },
  },
  required: ["reply", "operations"],
};

const CONFIG_PATH = resolve(DATA_DIR, "agent-config.json");

function loadConfig(): StoredAgentConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<StoredAgentConfig>;
      const profiles = Array.isArray(raw.profiles)
        ? raw.profiles.filter(
            (p): p is AgentProfile =>
              Boolean(
                p &&
                  typeof p.id === "string" &&
                  p.id !== BUILTIN_MUSE_PROFILE.id &&
                  p.id !== BUILTIN_AGY_PROFILE.id,
              ),
          )
        : [];
      const activeProfileId =
        typeof raw.activeProfileId === "string" &&
        (raw.activeProfileId === BUILTIN_MUSE_PROFILE.id ||
          raw.activeProfileId === BUILTIN_AGY_PROFILE.id ||
          profiles.some((p) => p.id === raw.activeProfileId))
          ? raw.activeProfileId
          : BUILTIN_MUSE_PROFILE.id;
      return { activeProfileId, profiles };
    }
  } catch {
    // 配置文件损坏时回退默认，避免阻塞启动
  }
  return { activeProfileId: BUILTIN_MUSE_PROFILE.id, profiles: [] };
}

function saveConfig(cfg: StoredAgentConfig): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 2) return "*".repeat(trimmed.length);
  if (trimmed.length <= 8) {
    return `${trimmed[0]}${"*".repeat(trimmed.length - 2)}${trimmed.slice(-1)}`;
  }
  const starCount = Math.min(12, trimmed.length - 8);
  return `${trimmed.slice(0, 4)}${"*".repeat(starCount)}${trimmed.slice(-4)}`;
}

function toMasked(p: AgentProfile, builtin = false): MaskedAgentProfile {
  return {
    id: p.id,
    name: p.name,
    provider: p.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKeyMasked: maskKey(p.apiKey),
    hasApiKey: Boolean(p.apiKey.trim()),
    ...(builtin ? { builtin: true } : {}),
  };
}

function getBuiltinAgyProfile(): AgentProfile {
  const agyCfg = loadAgyConfig();
  return {
    ...BUILTIN_AGY_PROFILE,
    model: agyCfg.model || BUILTIN_AGY_PROFILE.model,
  };
}

function getAllProfiles(cfg: StoredAgentConfig): AgentProfile[] {
  return [BUILTIN_MUSE_PROFILE, getBuiltinAgyProfile(), ...cfg.profiles];
}

function resolveOpenAiEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("请填写 OpenAI 接口地址（Base URL）");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  const parsed = new URL(trimmed);
  if (parsed.pathname === "/" || parsed.pathname === "") {
    return `${trimmed}/v1/chat/completions`;
  }
  return `${trimmed}/chat/completions`;
}

function resolveAnthropicEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("请填写 Anthropic 接口地址（Base URL）");
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

export function resolveModelsEndpoint(provider: "openai" | "anthropic", baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("请填写接口地址（Base URL）");
  if (provider === "anthropic") {
    const base = trimmed.replace(/\/messages$/, "");
    return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  }
  const base = trimmed.replace(/\/chat\/completions$/, "");
  const parsed = new URL(base);
  if (parsed.pathname === "/" || parsed.pathname === "") {
    return `${base}/v1/models`;
  }
  return `${base}/models`;
}

async function fetchAvailableModels(
  provider: "openai" | "anthropic",
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const endpoint = resolveModelsEndpoint(provider, baseUrl);
  const headers: Record<string, string> = {};
  const key = apiKey.trim();
  if (provider === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }

  const resp = await fetch(endpoint, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`拉取模型失败 (${resp.status})：${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text) as {
    data?: Array<{ id?: unknown } | string>;
    models?: Array<{ id?: unknown; name?: unknown } | string>;
  };
  const rawList = Array.isArray(parsed.data)
    ? parsed.data
    : Array.isArray(parsed.models)
      ? parsed.models
      : [];
  const ids = rawList
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const id = "id" in item ? item.id : "name" in item ? item.name : "";
        return typeof id === "string" ? id.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
  const unique = Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  if (unique.length === 0) {
    throw new Error("接口未返回可用模型列表");
  }
  return unique;
}

export function buildAgentSystemPrompt(): string {
  return [
    "你是 YoYo无限画布 的智能创作 Agent。你可以读取当前画布的节点与连线关系，帮用户构思分镜/提示词，并通过返回结构化指令直接操作画布（创建节点、修改节点、连线、触发生成）。",
    "",
    "你必须严格只输出一个合法 JSON 对象，不要输出任何额外说明或代码块以外的文字。格式如下：",
    "{",
    '  "reply": "用简洁自然的中文回答用户，并说明你做了什么操作（如仅回答问题，operations 传空数组 []）",',
    '  "operations": [',
    "    // 可选动作列表：",
    '    // 1. 创建节点: { "op": "create_node", "tempId": "n1", "type": "text|image|video|audio|config|sticky-note|video-frames|video-relay|audio-extract|video-compose|prompt-reverse", "title": "节点标题", "prompt": "生成提示词", "content": "文本内容(仅text/sticky-note)", "genRatio": "16:9|9:16|1:1|3:2|2:3|4:3|3:4|21:9", "genDuration": 5, "nearNodeId": "可选参考位置节点id" }',
    '    // 2. 插入资产库里的资产到画布: { "op": "insert_asset", "tempId": "a1", "assetId": "资产id", "title": "可选显示标题", "nearNodeId": "可选参考位置节点id" }',
    '    // 3. 修改节点: { "op": "update_node", "nodeId": "已有节点id", "title": "可选", "prompt": "可选", "content": "可选", "genRatio": "可选", "genDuration": 5 }',
    '    // 4. 删除节点: { "op": "delete_node", "nodeId": "已有节点id" }',
    '    // 5. 连线(参考/输入 -> 目标节点): { "op": "connect", "source": "已有节点id或tempId", "target": "已有节点id或tempId" }',
    '    // 6. 断开连线: { "op": "disconnect", "source": "已有节点id", "target": "已有节点id" }',
    '    // 7. 触发生成: { "op": "trigger_generate", "nodeId": "已有节点id或tempId" }',
    '    // 8. 自动分组(把2个以上节点框成组): { "op": "group_nodes", "nodeIds": ["id1或tempId", "id2或tempId"], "title": "分组标题" }',
    '    // 9. 存入提示词库: { "op": "save_prompt", "title": "提示词标题", "content": "提示词正文" }',
    "  ]",
    "}",
    "",
    "规则：",
    "1. 只有用户明确要求生成、运行或出图/出视频时，才附带 trigger_generate；如果只是让写提示词或搭工作流，只建节点和连线即可。",
    "2. 连线方向：参考图/参考视频/文本提示词节点作为 source，连向目标 image/video/audio/tool 节点（target）。当有多个参考图（如 图1、图2）时，按用户提到的顺序依次 connect 到目标节点。",
    "3. 当用户消息里出现 @[asset:<assetId>:<名称>] 或提到资产库里的资产时，先检查上下文里当前画布是否已有对应媒体节点；若没有，使用 insert_asset 把对应 assetId 插入画布并赋予 tempId，再 connect 到目标生成节点。",
    "4. 引用已有节点时，必须使用上下文里提供的精确 id；新建或插入节点在同一批需要被连线或触发生成时，用 tempId（如 n1, a1）指代。",
    "5. prompt 字段请写可直接用于 AI 生图/生视频的高质量描述词（如引用多个参考图，可在提示词中用“图1”“图2”对应角色/元素）；同时在 reply 里简明列出你生成或修改后的新提示词全文，方便用户在对话中直接查看。",
  ].join("\n");
}

export function parseAgentJsonResponse(rawText: string): AgentParsedResponse {
  const trimmed = rawText.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        reply?: unknown;
        operations?: unknown;
      };
      if (parsed && typeof parsed === "object") {
        const reply =
          typeof parsed.reply === "string" && parsed.reply.trim()
            ? parsed.reply
            : trimmed;
        const operations = Array.isArray(parsed.operations)
          ? (parsed.operations.filter(
              (item): item is AgentOperation =>
                Boolean(item && typeof item === "object" && typeof (item as { op?: unknown }).op === "string"),
            ) as AgentOperation[])
          : [];
        return { reply, operations };
      }
    } catch {
      // 继续尝试下一个候选片段
    }
  }
  return { reply: trimmed || "（模型未返回内容）", operations: [] };
}

async function callOpenAiChat(
  profile: AgentProfile,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  maxTokens = 16384,
  timeoutMs = 90_000,
  abortSignal?: AbortSignal,
): Promise<string> {
  const endpoint = resolveOpenAiEndpoint(profile.baseUrl);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (profile.apiKey.trim()) {
    headers.authorization = `Bearer ${profile.apiKey.trim()}`;
  }
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: profile.model.trim() || "gpt-4o-mini",
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI 接口返回 ${resp.status}：${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? "").join("");
  }
  throw new Error("OpenAI 接口返回缺少 choices[0].message.content");
}

async function callAnthropicChat(
  profile: AgentProfile,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  maxTokens = 16384,
  timeoutMs = 90_000,
  allowThinkingFallback = false,
  abortSignal?: AbortSignal,
): Promise<string> {
  const endpoint = resolveAnthropicEndpoint(profile.baseUrl);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (profile.apiKey.trim()) {
    headers["x-api-key"] = profile.apiKey.trim();
  }
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: profile.model.trim() || "claude-sonnet-4-20250514",
      system,
      messages,
      max_tokens: maxTokens,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Anthropic 接口返回 ${resp.status}：${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text) as {
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
  };
  const joined = (data.content ?? [])
    .filter((block) => block.type === "text" || typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
  if (!joined) {
    if (allowThinkingFallback) {
      const thinking = (data.content ?? [])
        .map((block) => block.thinking ?? "")
        .join("")
        .trim();
      if (thinking) return thinking;
    }
    throw new Error("模型思考过程耗尽了输出额度，未返回最终结果，请重试或精简需求");
  }
  return joined;
}

type VisionImage = {
  label: string;
  mimeType: string;
  base64: string;
};

const ALLOWED_VISION_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_VISION_BYTES = 4 * 1024 * 1024;

function materializeAgyVisionImages(
  refs?: { label?: string; mediaUrl?: string }[],
): { dir: string; files: { label: string; path: string }[] } | null {
  const images = loadVisionImages(refs);
  if (images.length === 0) return null;
  const dir = resolve(DATA_DIR, "tmp-agy-vision");
  mkdirSync(dir, { recursive: true });
  const files: { label: string; path: string }[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const ext =
      img.mimeType === "image/png"
        ? "png"
        : img.mimeType === "image/webp"
          ? "webp"
          : img.mimeType === "image/gif"
            ? "gif"
            : "jpg";
    const filePath = resolve(dir, `ref-${Date.now()}-${i}.${ext}`);
    writeFileSync(filePath, Buffer.from(img.base64, "base64"));
    files.push({ label: img.label, path: filePath });
  }
  return { dir, files };
}

function loadVisionImages(
  refs?: { label?: string; mediaUrl?: string }[],
): VisionImage[] {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const out: VisionImage[] = [];
  for (const ref of refs.slice(0, 4)) {
    const url = ref?.mediaUrl ?? "";
    if (!url.startsWith("/blobs/")) continue;
    const key = url
      .slice("/blobs/".length)
      .split("/")
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .join("/");
    const found = readBlobBytes(key);
    if (!found) continue;
    const mime = found.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ALLOWED_VISION_MIMES.has(mime)) continue;
    if (found.bytes.byteLength > MAX_VISION_BYTES) continue;
    out.push({
      label: ref.label || "参考图",
      mimeType: mime,
      base64: Buffer.from(found.bytes).toString("base64"),
    });
  }
  return out;
}

function buildOpenAiPayloadMessages(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  images: VisionImage[],
) {
  return [
    { role: "system", content: system },
    ...messages.map((m, idx, arr) => {
      if (idx === arr.length - 1 && m.role === "user" && images.length > 0) {
        return {
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
          ],
        };
      }
      return m;
    }),
  ];
}

function buildAnthropicPayloadMessages(
  messages: { role: "user" | "assistant"; content: string }[],
  images: VisionImage[],
) {
  return messages.map((m, idx, arr) => {
    if (idx === arr.length - 1 && m.role === "user" && images.length > 0) {
      return {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mimeType,
              data: img.base64,
            },
          })),
          { type: "text", text: m.content },
        ],
      };
    }
    return m;
  });
}

function sseLine(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamVisionChat(
  profile: AgentProfile,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  images: VisionImage[],
  abortSignal?: AbortSignal,
): Promise<Response> {
  const isOpenAi = profile.provider === "openai";
  const endpoint = isOpenAi
    ? resolveOpenAiEndpoint(profile.baseUrl)
    : resolveAnthropicEndpoint(profile.baseUrl);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (isOpenAi) {
    if (profile.apiKey.trim()) headers.authorization = `Bearer ${profile.apiKey.trim()}`;
  } else {
    headers["anthropic-version"] = "2023-06-01";
    if (profile.apiKey.trim()) headers["x-api-key"] = profile.apiKey.trim();
  }

  const bodyPayload = isOpenAi
    ? {
        model: profile.model.trim() || "gpt-4o-mini",
        messages: buildOpenAiPayloadMessages(system, messages, images),
        max_tokens: 16384,
        temperature: 0.7,
        stream: true,
      }
    : {
        model: profile.model.trim() || "claude-sonnet-4-20250514",
        system,
        messages: buildAnthropicPayloadMessages(messages, images),
        max_tokens: 16384,
        stream: true,
      };

  const signal = abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(300_000)])
    : AbortSignal.timeout(300_000);

  const upstream = await fetch(endpoint, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify(bodyPayload),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    throw new Error(
      `${isOpenAi ? "OpenAI" : "Anthropic"} 接口返回 ${upstream.status}：${errText.slice(0, 300)}`,
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !upstream.body) {
    const raw = await upstream.text();
    const data = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      content?: Array<{ type?: string; text?: string }>;
    };
    const rawText = isOpenAi
      ? typeof data.choices?.[0]?.message?.content === "string"
        ? data.choices[0].message.content
        : Array.isArray(data.choices?.[0]?.message?.content)
          ? data.choices[0].message.content.map((p) => p.text ?? "").join("")
          : ""
      : (data.content ?? [])
          .filter((b) => b.type === "text" || typeof b.text === "string")
          .map((b) => b.text ?? "")
          .join("");
    if (!rawText) {
      throw new Error("模型未返回有效文本内容");
    }
    const parsed = parseAgentJsonResponse(rawText);
    return json({ status: "done", reply: parsed.reply, operations: parsed.operations });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let fullText = "";
      let thinkingChars = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let obj: Record<string, unknown>;
            try {
              obj = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (isOpenAi) {
              const choices = obj.choices as
                | Array<{ delta?: { content?: string; reasoning_content?: string } }>
                | undefined;
              const delta = choices?.[0]?.delta;
              if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
                thinkingChars += delta.reasoning_content.length;
                controller.enqueue(sseLine("thinking", { chars: thinkingChars }));
              }
              if (typeof delta?.content === "string" && delta.content) {
                fullText += delta.content;
                controller.enqueue(sseLine("delta", { text: delta.content, totalChars: fullText.length }));
              }
            } else {
              const type = obj.type;
              if (type === "content_block_delta") {
                const delta = obj.delta as { type?: string; text?: string; thinking?: string } | undefined;
                if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                  thinkingChars += delta.thinking.length;
                  controller.enqueue(sseLine("thinking", { chars: thinkingChars }));
                } else if (typeof delta?.text === "string" && delta.text) {
                  fullText += delta.text;
                  controller.enqueue(sseLine("delta", { text: delta.text, totalChars: fullText.length }));
                }
              }
            }
          }
        }
        if (!fullText.trim()) {
          controller.enqueue(
            sseLine("error", {
              error: "模型思考过程耗尽了输出额度，未返回最终结果，请重试或精简需求",
            }),
          );
        } else {
          const parsed = parseAgentJsonResponse(fullText);
          controller.enqueue(
            sseLine("done", {
              reply: parsed.reply,
              operations: parsed.operations,
            }),
          );
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          controller.enqueue(
            sseLine("error", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

type MuseTurnState = {
  turnId: string;
  jobId: string;
  status: "pending" | "done" | "failed";
  reply?: string;
  operations?: AgentOperation[];
  error?: string;
  createdAt: number;
};

const museTurns = new Map<string, MuseTurnState>();

export function settleAgentBridgeTurn(
  turnId: string,
  outcome: { ok: true; text: string } | { ok: false; error: string },
): void {
  const turn = museTurns.get(turnId);
  if (!turn || turn.status !== "pending") return;
  if (outcome.ok) {
    const parsed = parseAgentJsonResponse(outcome.text);
    turn.status = "done";
    turn.reply = parsed.reply;
    turn.operations = parsed.operations;
  } else {
    turn.status = "failed";
    turn.error = outcome.error;
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export type StoredAgentSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: unknown[];
};

type StoredProjectHistory = {
  activeSessionId: string | null;
  sessions: StoredAgentSession[];
};

const HISTORY_DIR = resolve(DATA_DIR, "agent-history");

function historyPathForProject(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "default";
  return resolve(HISTORY_DIR, `${safe}.json`);
}

function loadProjectHistory(projectId: string): StoredProjectHistory {
  try {
    const p = historyPathForProject(projectId);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<StoredProjectHistory>;
      const sessions = Array.isArray(raw.sessions)
        ? raw.sessions.filter(
            (s): s is StoredAgentSession =>
              Boolean(s && typeof s.id === "string" && Array.isArray(s.messages)),
          )
        : [];
      sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const activeSessionId =
        typeof raw.activeSessionId === "string" &&
        sessions.some((s) => s.id === raw.activeSessionId)
          ? raw.activeSessionId
          : (sessions[0]?.id ?? null);
      return { activeSessionId, sessions };
    }
  } catch {
    // ignore corrupt history file
  }
  return { activeSessionId: null, sessions: [] };
}

function saveProjectHistory(projectId: string, history: StoredProjectHistory): void {
  mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(
    historyPathForProject(projectId),
    JSON.stringify(history, null, 2),
    "utf8",
  );
}

export type StoredAgentSkill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  defaultPrompt: string;
  instructions: string;
  enabled: boolean;
  updatedAt: number;
};

const SKILLS_PATH = resolve(DATA_DIR, "agent-skills.json");

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function loadSkills(): StoredAgentSkill[] {
  try {
    if (existsSync(SKILLS_PATH)) {
      const raw = JSON.parse(readFileSync(SKILLS_PATH, "utf8")) as {
        skills?: unknown;
      };
      if (Array.isArray(raw.skills)) {
        return raw.skills.filter(
          (s): s is StoredAgentSkill =>
            Boolean(s && typeof s.id === "string" && typeof s.slug === "string"),
        );
      }
    }
  } catch {
    // ignore corrupt skills file
  }
  return [];
}

function saveSkills(skills: StoredAgentSkill[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SKILLS_PATH, JSON.stringify({ skills }, null, 2), "utf8");
}

export function matchEnabledSkills(
  skills: StoredAgentSkill[],
  text: string,
): StoredAgentSkill[] {
  return skills.filter((s) => {
    if (!s.enabled || !s.slug) return false;
    const escaped = s.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)\\$${escaped}(?=\\s|$|[，。,.!?！？:：])`, "i").test(text);
  });
}

function parseSkillDraftJson(rawText: string): {
  slug: string;
  name: string;
  description: string;
  defaultPrompt: string;
  instructions: string;
} {
  const trimmed = rawText.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const p = JSON.parse(candidate) as Record<string, unknown>;
      if (p && typeof p === "object") {
        const slug = normalizeSlug(String(p.slug ?? p.identifier ?? "custom-skill")) || "custom-skill";
        const name = String(p.name ?? slug).trim() || slug;
        const description = String(p.description ?? "").trim();
        const defaultPrompt = String(p.defaultPrompt ?? `请使用 $${slug} 处理当前需求`).trim();
        const instructions = String(p.instructions ?? "").trim();
        if (instructions) {
          return { slug, name, description, defaultPrompt, instructions };
        }
      }
    } catch {
      // try next
    }
  }
  throw new Error("模型未返回有效的 Skill 草稿 JSON");
}

export async function handleAgent(
  req: Request,
  url: URL,
  deps: { db: Db },
): Promise<Response> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/agent/config") {
    const cfg = loadConfig();
    const agyStatus = await getAgyStatus(false);
    const builtinAgy = getBuiltinAgyProfile();
    const matchedModel = agyStatus.models.find((m) => m.id === builtinAgy.model);
    const agyProfile: MaskedAgentProfile = {
      ...toMasked(builtinAgy, true),
      ready: agyStatus.ready,
      modelLabel: matchedModel?.label ?? builtinAgy.model,
    };
    return json({
      activeProfileId: cfg.activeProfileId,
      profiles: [
        toMasked(BUILTIN_MUSE_PROFILE, true),
        agyProfile,
        ...cfg.profiles.map((p) => toMasked(p)),
      ],
    });
  }

  if (req.method === "POST" && path === "/agent/config/activate") {
    const body = (await req.json().catch(() => null)) as { id?: string } | null;
    if (!body?.id) return json({ error: "缺少 id" }, 400);
    const cfg = loadConfig();
    if (body.id === BUILTIN_AGY_PROFILE.id) {
      const agyStatus = await getAgyStatus(false);
      if (!agyStatus.ready) {
        return json(
          { error: "AGY CLI 尚未部署、登录或启用，请先在顶部「AGY 引擎」完成配置" },
          400,
        );
      }
    } else if (
      body.id !== BUILTIN_MUSE_PROFILE.id &&
      !cfg.profiles.some((p) => p.id === body.id)
    ) {
      return json({ error: "模型配置不存在" }, 404);
    }
    cfg.activeProfileId = body.id;
    saveConfig(cfg);
    return json({ ok: true, activeProfileId: cfg.activeProfileId });
  }

  if (req.method === "POST" && path === "/agent/config/save") {
    const body = (await req.json().catch(() => null)) as
      | {
          id?: string;
          name?: string;
          provider?: AgentProvider;
          baseUrl?: string;
          apiKey?: string;
          model?: string;
          activate?: boolean;
        }
      | null;
    if (!body?.name?.trim()) return json({ error: "请填写配置名称" }, 400);
    if (body.provider !== "openai" && body.provider !== "anthropic") {
      return json({ error: "仅支持 openai 或 anthropic 格式" }, 400);
    }
    if (!body.baseUrl?.trim()) return json({ error: "请填写 Base URL" }, 400);
    if (!body.model?.trim()) return json({ error: "请填写模型名称" }, 400);

    const cfg = loadConfig();
    const existing = body.id
      ? cfg.profiles.find((p) => p.id === body.id)
      : undefined;
    const trimmedKey = body.apiKey?.trim() ?? "";
    const isUnchangedMasked = existing && trimmedKey === maskKey(existing.apiKey);
    const nextApiKey =
      trimmedKey && !isUnchangedMasked ? trimmedKey : (existing?.apiKey ?? "");
    const saved: AgentProfile = {
      id: existing?.id ?? `custom-${randomUUID().slice(0, 8)}`,
      name: body.name.trim(),
      provider: body.provider,
      baseUrl: body.baseUrl.trim(),
      apiKey: nextApiKey,
      model: body.model.trim(),
    };
    if (existing) {
      cfg.profiles = cfg.profiles.map((p) => (p.id === saved.id ? saved : p));
    } else {
      cfg.profiles.push(saved);
    }
    if (body.activate !== false) {
      cfg.activeProfileId = saved.id;
    }
    saveConfig(cfg);
    return json({
      ok: true,
      profile: toMasked(saved),
      activeProfileId: cfg.activeProfileId,
    });
  }

  if (req.method === "POST" && path === "/agent/config/delete") {
    const body = (await req.json().catch(() => null)) as { id?: string } | null;
    if (
      !body?.id ||
      body.id === BUILTIN_MUSE_PROFILE.id ||
      body.id === BUILTIN_AGY_PROFILE.id
    ) {
      return json({ error: "内置模型配置不可删除" }, 400);
    }
    const cfg = loadConfig();
    cfg.profiles = cfg.profiles.filter((p) => p.id !== body.id);
    if (cfg.activeProfileId === body.id) {
      cfg.activeProfileId = BUILTIN_MUSE_PROFILE.id;
    }
    saveConfig(cfg);
    return json({ ok: true, activeProfileId: cfg.activeProfileId });
  }

  if (req.method === "POST" && path === "/agent/models") {
    const body = (await req.json().catch(() => null)) as
      | {
          id?: string;
          provider?: AgentProvider;
          baseUrl?: string;
          apiKey?: string;
        }
      | null;
    const cfg = loadConfig();
    const existing = body?.id
      ? getAllProfiles(cfg).find((p) => p.id === body.id)
      : undefined;
    const provider = body?.provider ?? existing?.provider;
    if (provider !== "openai" && provider !== "anthropic") {
      return json({ ok: false, error: "仅支持 openai 或 anthropic 格式" }, 400);
    }
    const baseUrl = (body?.baseUrl ?? existing?.baseUrl ?? "").trim();
    const trimmedKey = body?.apiKey?.trim() ?? "";
    const isUnchangedMasked = existing && trimmedKey === maskKey(existing.apiKey);
    const apiKey =
      trimmedKey && !isUnchangedMasked ? trimmedKey : (existing?.apiKey ?? "");
    try {
      const models = await fetchAvailableModels(provider, baseUrl, apiKey);
      return json({ ok: true, models });
    } catch (err) {
      return json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (req.method === "POST" && path === "/agent/test") {
    const body = (await req.json().catch(() => null)) as
      | {
          id?: string;
          provider?: AgentProvider;
          baseUrl?: string;
          apiKey?: string;
          model?: string;
        }
      | null;
    const cfg = loadConfig();
    const existing = body?.id
      ? getAllProfiles(cfg).find((p) => p.id === body.id)
      : undefined;
    const provider = body?.provider ?? existing?.provider;
    if (!provider) return json({ ok: false, error: "缺少 provider" }, 400);

    const startedAt = Date.now();
    try {
      if (provider === "muse") {
        const profiles = effectiveProfiles().profiles;
        if (profiles.length === 0) {
          return json({
            ok: false,
            error: "YoYo桥尚未配对 Muse 账号，请先点击顶部「YoYo桥」完成配对",
            latencyMs: Date.now() - startedAt,
          });
        }
        return json({
          ok: true,
          message: `YoYo桥已配对（${profiles.length} 个档案可用），Muse Agent 通道就绪`,
          latencyMs: Date.now() - startedAt,
        });
      }

      if (provider === "agy") {
        const agyStatus = await getAgyStatus(false);
        if (!agyStatus.ready) {
          return json({
            ok: false,
            error: "AGY CLI 尚未部署、登录或启用，请先在顶部「AGY 引擎」完成配置",
            latencyMs: Date.now() - startedAt,
          });
        }
        const res = await runAgyPrompt({
          prompt: "Reply with exactly: OK",
          model: (body?.model ?? agyStatus.model).trim(),
          timeoutMs: 30_000,
        });
        return json({
          ok: true,
          message: `连接成功（AGY 模型响应：${res.response.trim().slice(0, 40)}）`,
          latencyMs: Date.now() - startedAt,
        });
      }

      const trimmedTestKey = body?.apiKey?.trim() ?? "";
      const isUnchangedTestMasked =
        existing && trimmedTestKey === maskKey(existing.apiKey);
      const probeProfile: AgentProfile = {
        id: existing?.id ?? "test",
        name: existing?.name ?? "test",
        provider,
        baseUrl: (body?.baseUrl ?? existing?.baseUrl ?? "").trim(),
        apiKey:
          trimmedTestKey && !isUnchangedTestMasked
            ? trimmedTestKey
            : (existing?.apiKey ?? ""),
        model: (body?.model ?? existing?.model ?? "").trim(),
      };

      const reply =
        provider === "openai"
          ? await callOpenAiChat(
              probeProfile,
              "Reply with OK.",
              [{ role: "user", content: "hi" }],
              256,
              15_000,
            )
          : await callAnthropicChat(
              probeProfile,
              "Reply with OK.",
              [{ role: "user", content: "hi" }],
              256,
              15_000,
              true,
            );
      return json({
        ok: true,
        message: `连接成功（模型响应：${reply.trim().slice(0, 40)}）`,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      return json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
    }
  }

  if (req.method === "POST" && path === "/agent/chat") {
    const body = (await req.json().catch(() => null)) as
      | {
          profileId?: string;
          messages?: { role: "user" | "assistant"; content: string }[];
          canvasContext?: string;
          imageRefs?: { label?: string; mediaUrl?: string }[];
          stream?: boolean;
        }
      | null;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return json({ error: "消息不能为空" }, 400);
    }

    const cfg = loadConfig();
    const targetId = body?.profileId || cfg.activeProfileId;
    const profile =
      getAllProfiles(cfg).find((p) => p.id === targetId) ?? BUILTIN_MUSE_PROFILE;

    const lastUserText =
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const matchedSkills = matchEnabledSkills(loadSkills(), lastUserText);
    const skillSection =
      matchedSkills.length > 0
        ? `\n\n【已激活的 Skill 规范（必须严格遵循）】\n${matchedSkills
            .map(
              (s) =>
                `### Skill: $${s.slug} (${s.name})\n${s.instructions}`,
            )
            .join("\n\n")}`
        : "";

    const systemPrompt = `${buildAgentSystemPrompt()}${skillSection}`;
    const contextBlock = body?.canvasContext
      ? `\n\n【当前画布实时状态】\n${body.canvasContext}`
      : "";

    if (profile.provider === "muse") {
      if (effectiveProfiles().profiles.length === 0) {
        return json(
          { error: "YoYo桥尚未配对，请先在顶部「YoYo桥」完成配对后再使用 Muse Agent" },
          400,
        );
      }
      const turnId = randomUUID();
      const historyText = messages
        .slice(-10)
        .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
        .join("\n\n");
      const fullPrompt = `${historyText}${contextBlock}`;
      const job = await createBridgeJob(deps.db, {
        kind: "text",
        nodeId: null,
        projectId: null,
        dedupeKey: `agent-turn-${turnId}`,
        payload: {
          prompt: fullPrompt,
          system: systemPrompt,
          agentTurnId: turnId,
        },
      });
      museTurns.set(turnId, {
        turnId,
        jobId: job.jobId,
        status: "pending",
        createdAt: Date.now(),
      });
      return json({ status: "pending", turnId, jobId: job.jobId });
    }

    if (profile.provider === "agy") {
      const agyStatus = await getAgyStatus(false);
      if (!agyStatus.ready) {
        return json(
          { error: "AGY CLI 尚未部署、登录或启用，请先在顶部「AGY 引擎」完成配置" },
          400,
        );
      }
      const vision = materializeAgyVisionImages(body?.imageRefs);
      const visionHint = vision
        ? `\n\n【附带本地参考图（请使用工具读取查看）】\n${vision.files
            .map((f) => `- ${f.label}: ${f.path}`)
            .join("\n")}`
        : "";
      const historyText = messages
        .slice(-12)
        .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
        .join("\n\n");
      const fullPrompt = [
        `系统指令：\n${systemPrompt}`,
        `对话记录：\n${historyText}${contextBlock}${visionHint}`,
        `请严格按 JSON Schema 返回 {"reply": "...", "operations": [...]}。`,
      ].join("\n\n");
      const addDirs = vision ? [vision.dir] : [];
      if (body?.stream) {
        return streamAgyChat({
          prompt: fullPrompt,
          model: agyStatus.model,
          addDirs,
          jsonSchema: AGENT_RESPONSE_JSON_SCHEMA,
          parseResponse: parseAgentJsonResponse,
          abortSignal: req.signal,
        });
      }
      try {
        const res = await runAgyPrompt({
          prompt: fullPrompt,
          model: agyStatus.model,
          addDirs,
          jsonSchema: AGENT_RESPONSE_JSON_SCHEMA,
          timeoutMs: 300_000,
          signal: req.signal,
        });
        const structured = res.structuredOutput as
          | { reply?: unknown; operations?: unknown }
          | undefined;
        if (
          structured &&
          typeof structured === "object" &&
          typeof structured.reply === "string"
        ) {
          return json({
            status: "done",
            reply: structured.reply,
            operations: Array.isArray(structured.operations) ? structured.operations : [],
          });
        }
        const parsed = parseAgentJsonResponse(res.response);
        return json({
          status: "done",
          reply: parsed.reply,
          operations: parsed.operations,
        });
      } catch (err) {
        return json(
          { error: err instanceof Error ? err.message : String(err) },
          502,
        );
      }
    }

    try {
      const apiMessages = messages.slice(-16).map((m, idx, arr) =>
        idx === arr.length - 1 && m.role === "user" && contextBlock
          ? { role: m.role, content: `${m.content}${contextBlock}` }
          : m,
      );
      const images = loadVisionImages(body?.imageRefs);
      if (body?.stream) {
        return await streamVisionChat(
          profile,
          systemPrompt,
          apiMessages,
          images,
          req.signal,
        );
      }
      const rawText =
        profile.provider === "openai"
          ? await callOpenAiChat(
              profile,
              systemPrompt,
              apiMessages,
              16384,
              300_000,
              req.signal,
            )
          : await callAnthropicChat(
              profile,
              systemPrompt,
              apiMessages,
              16384,
              300_000,
              false,
              req.signal,
            );
      const parsed = parseAgentJsonResponse(rawText);
      return json({
        status: "done",
        reply: parsed.reply,
        operations: parsed.operations,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        (err instanceof Error && err.name === "TimeoutError") ||
        /timed out/i.test(msg);
      return json(
        {
          error: isTimeout
            ? "模型响应超时（请检查网络/中转站状态，或换用响应更快的模型重试）"
            : msg,
        },
        502,
      );
    }
  }

  if (req.method === "GET" && path === "/agent/turn") {
    const turnId = url.searchParams.get("turnId") ?? "";
    if (!turnId) return json({ error: "缺少 turnId" }, 400);
    const turn = museTurns.get(turnId);
    if (!turn) return json({ error: "会话轮次不存在" }, 404);
    if (turn.status === "pending") {
      const job = await getBridgeJob(deps.db, turn.jobId);
      if (job?.status === "failed") {
        turn.status = "failed";
        turn.error = job.error ?? "Muse 桥任务失败";
      }
    }
    return json({
      turnId: turn.turnId,
      status: turn.status,
      reply: turn.reply,
      operations: turn.operations,
      error: turn.error,
    });
  }

  if (req.method === "POST" && path === "/agent/turn/cancel") {
    const body = (await req.json().catch(() => null)) as { turnId?: string } | null;
    if (!body?.turnId) return json({ error: "缺少 turnId" }, 400);
    const turn = museTurns.get(body.turnId);
    if (turn && turn.status === "pending") {
      turn.status = "failed";
      turn.error = "已手动停止";
      await settleBridgeJob(deps.db, turn.jobId, "failed", "用户手动停止 Agent 对话");
    }
    return json({ ok: true });
  }

  if (req.method === "GET" && path === "/agent/history") {
    const projectId = url.searchParams.get("projectId") ?? "";
    if (!projectId) return json({ activeSessionId: null, sessions: [] });
    return json(loadProjectHistory(projectId));
  }

  if (req.method === "POST" && path === "/agent/history/save") {
    const body = (await req.json().catch(() => null)) as {
      projectId?: string;
      session?: StoredAgentSession;
    } | null;
    if (!body?.projectId || !body.session?.id) {
      return json({ error: "缺少 projectId 或 session" }, 400);
    }
    const history = loadProjectHistory(body.projectId);
    const nextSession: StoredAgentSession = {
      id: body.session.id,
      title: (body.session.title || "新对话").slice(0, 60),
      updatedAt: body.session.updatedAt || Date.now(),
      messages: Array.isArray(body.session.messages) ? body.session.messages : [],
    };
    const filtered = history.sessions.filter((s) => s.id !== nextSession.id);
    history.sessions = [nextSession, ...filtered].slice(0, 30);
    history.activeSessionId = nextSession.id;
    saveProjectHistory(body.projectId, history);
    return json({ ok: true, activeSessionId: history.activeSessionId });
  }

  if (req.method === "POST" && path === "/agent/history/activate") {
    const body = (await req.json().catch(() => null)) as {
      projectId?: string;
      sessionId?: string | null;
    } | null;
    if (!body?.projectId) return json({ error: "缺少 projectId" }, 400);
    const history = loadProjectHistory(body.projectId);
    history.activeSessionId = body.sessionId ?? null;
    saveProjectHistory(body.projectId, history);
    return json({ ok: true });
  }

  if (req.method === "POST" && path === "/agent/history/delete") {
    const body = (await req.json().catch(() => null)) as {
      projectId?: string;
      sessionId?: string;
    } | null;
    if (!body?.projectId || !body.sessionId) {
      return json({ error: "缺少 projectId 或 sessionId" }, 400);
    }
    const history = loadProjectHistory(body.projectId);
    history.sessions = history.sessions.filter((s) => s.id !== body.sessionId);
    if (history.activeSessionId === body.sessionId) {
      history.activeSessionId = history.sessions[0]?.id ?? null;
    }
    saveProjectHistory(body.projectId, history);
    return json({
      ok: true,
      activeSessionId: history.activeSessionId,
      sessions: history.sessions,
    });
  }

  if (req.method === "GET" && path === "/agent/skills") {
    return json({ skills: loadSkills() });
  }

  if (req.method === "POST" && path === "/agent/skills/save") {
    const body = (await req.json().catch(() => null)) as {
      id?: string;
      slug?: string;
      name?: string;
      description?: string;
      defaultPrompt?: string;
      instructions?: string;
      enabled?: boolean;
    } | null;
    const slug = normalizeSlug(body?.slug ?? "");
    if (!slug) return json({ error: "请填写有效的 Skill 标识（英文/数字/短横线）" }, 400);
    if (!body?.name?.trim()) return json({ error: "请填写 Skill 名称" }, 400);
    if (!body?.instructions?.trim()) return json({ error: "请填写 Skill 规则正文" }, 400);

    const skills = loadSkills();
    const existing = body.id ? skills.find((s) => s.id === body.id) : undefined;
    const conflict = skills.find((s) => s.slug === slug && s.id !== existing?.id);
    if (conflict) return json({ error: `Skill 标识 $${slug} 已存在` }, 400);

    const saved: StoredAgentSkill = {
      id: existing?.id ?? `skill-${randomUUID().slice(0, 8)}`,
      slug,
      name: body.name.trim(),
      description: (body.description ?? "").trim(),
      defaultPrompt:
        (body.defaultPrompt ?? "").trim() || `请使用 $${slug} 处理当前需求`,
      instructions: body.instructions.trim(),
      enabled: body.enabled ?? existing?.enabled ?? true,
      updatedAt: Date.now(),
    };
    const next = existing
      ? skills.map((s) => (s.id === saved.id ? saved : s))
      : [saved, ...skills];
    saveSkills(next);
    return json({ ok: true, skill: saved, skills: next });
  }

  if (req.method === "POST" && path === "/agent/skills/toggle") {
    const body = (await req.json().catch(() => null)) as {
      id?: string;
      enabled?: boolean;
    } | null;
    if (!body?.id || typeof body.enabled !== "boolean") {
      return json({ error: "缺少 id 或 enabled" }, 400);
    }
    const next = loadSkills().map((s) =>
      s.id === body.id ? { ...s, enabled: body.enabled!, updatedAt: Date.now() } : s,
    );
    saveSkills(next);
    return json({ ok: true, skills: next });
  }

  if (req.method === "POST" && path === "/agent/skills/delete") {
    const body = (await req.json().catch(() => null)) as { id?: string } | null;
    if (!body?.id) return json({ error: "缺少 id" }, 400);
    const next = loadSkills().filter((s) => s.id !== body.id);
    saveSkills(next);
    return json({ ok: true, skills: next });
  }

  if (req.method === "POST" && path === "/agent/skills/extract") {
    const body = (await req.json().catch(() => null)) as {
      mode?: "canvas" | "conversation";
      profileId?: string;
      canvasContext?: string;
      messages?: { role: "user" | "assistant"; content: string }[];
    } | null;
    if (body?.mode !== "canvas" && body?.mode !== "conversation") {
      return json({ error: "mode 仅支持 canvas 或 conversation" }, 400);
    }
    const cfg = loadConfig();
    const targetId = body.profileId || cfg.activeProfileId;
    const profile =
      getAllProfiles(cfg).find((p) => p.id === targetId) ?? BUILTIN_MUSE_PROFILE;
    if (profile.provider === "muse") {
      return json(
        { error: "一键提取 Skill 需先切换为 OpenAI 或 Anthropic 自定义模型（Muse 桥仅支持异步对话）" },
        400,
      );
    }

    const extractSystem = [
      "你是 YoYo无限画布 的 Skill 提炼助手。请把用户提供的画布工作流或成功对话，提炼为一个可复用的 Skill 模板。",
      "严格只输出一个 JSON 对象，不要输出任何额外文字：",
      "{",
      '  "slug": "小写英文短横线标识，例如 storyboard-3cut",',
      '  "name": "简短中文名称",',
      '  "description": "一句话说明用途",',
      '  "defaultPrompt": "必须包含 $slug 的默认调用语，例如：请用 $slug 生成...",',
      '  "instructions": "详细、可执行的 Agent 工作流指令（包含节点类型、连线顺序、提示词风格要求等）"',
      "}",
    ].join("\n");

    const sourceContent =
      body.mode === "canvas"
        ? `请从以下画布节点与连线结构中提炼可复用的工作流 Skill：\n\n${body.canvasContext || ""}`
        : `请从以下对话记录中提炼可复用的工作流 Skill：\n\n${(body.messages ?? [])
            .slice(-12)
            .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
            .join("\n\n")}`;

    if (profile.provider === "agy") {
      const agyStatus = await getAgyStatus(false);
      if (!agyStatus.ready) {
        return json(
          { error: "AGY CLI 尚未部署、登录或启用，请先在顶部「AGY 引擎」完成配置" },
          400,
        );
      }
      try {
        const res = await runAgyPrompt({
          prompt: `${extractSystem}\n\n${sourceContent}`,
          model: agyStatus.model,
          timeoutMs: 60_000,
          signal: req.signal,
        });
        const draft = parseSkillDraftJson(res.response);
        return json({ ok: true, draft });
      } catch (err) {
        return json(
          { error: err instanceof Error ? err.message : String(err) },
          502,
        );
      }
    }

    try {
      const raw =
        profile.provider === "openai"
          ? await callOpenAiChat(
              profile,
              extractSystem,
              [{ role: "user", content: sourceContent }],
              4096,
              60_000,
              req.signal,
            )
          : await callAnthropicChat(
              profile,
              extractSystem,
              [{ role: "user", content: sourceContent }],
              4096,
              60_000,
              false,
              req.signal,
            );
      const draft = parseSkillDraftJson(raw);
      return json({ ok: true, draft });
    } catch (err) {
      return json(
        { error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  }

  return json({ error: "unknown_agent_route" }, 404);
}
