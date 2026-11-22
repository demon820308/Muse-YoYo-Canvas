// [yoyo-local] 桥账号档案（多账号手动切换，Wei 2026-11-22 08:40
// 定版）：本地可保存多个 Muse 账号的桥配置，手动选一个为当前
// 账号，只有当前账号的桥能领新任务；不同时工作。隧道地址对所有账号是同一个（隧道指向本地机），账号之间唯一区别是各自的桥令牌。
//
// 存储：data/bridge.json
//   { "profiles": [{ id, label, token, createdAt }], "activeProfileId" }
// 兼容迁移：旧格式 { "token": "..." } 首次读取时自动成为 1 号档案
// （label「主账号」）并写回新格式，active 即它。
// 环境变量 YOYO_BRIDGE_TOKEN 存在时视为临时单档案：不落盘、恒为当前，文件档案暂时让位；移除环境变量后文件档案恢复生效。
// lastSeenAt 只存内存（任何一次带对令牌的请求即更新），重启丢失，
// README 已注明。本模块无内存缓存：每次读写都直达文件，管理页的
// 修改对桥端点即时生效、无需重启

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic-write";
import { DATA_DIR } from "./config";

export const MAX_BRIDGE_PROFILES = 8;

const BRIDGE_FILE = resolve(DATA_DIR, "bridge.json");
const ENV_PROFILE_ID = "env";

export type BridgeProfile = {
  id: string;
  label: string;
  token: string;
  createdAt: number;
};

export type BridgeProfilesFile = {
  profiles: BridgeProfile[];
  activeProfileId: string | null;
};


function sanitizeProfile(raw: unknown): BridgeProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.id !== "string" || !p.id ||
    typeof p.token !== "string" || !p.token.trim()
  ) {
    return null;
  }
  return {
    id: p.id,
    label: typeof p.label === "string" && p.label.trim() ? p.label.trim() : "未命名账号",
    token: p.token.trim(),
    createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
  };
}

function writeProfilesFile(file: BridgeProfilesFile): void {
  atomicWriteFileSync(BRIDGE_FILE, `${JSON.stringify(file, null, 2)}\n`);
}

/** 读档案文件（含旧格式迁移）。文件不存在/损坏 → 空配置。*/
export function readProfilesFile(): BridgeProfilesFile {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(BRIDGE_FILE, "utf8"));
  } catch {
    return { profiles: [], activeProfileId: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { profiles: [], activeProfileId: null };
  }
  const obj = parsed as Record<string, unknown>;

  // 新格
  if (Array.isArray(obj.profiles)) {
    const seenIds = new Set<string>();
    const seenTokens = new Set<string>();
    const profiles: BridgeProfile[] = [];
    for (const raw of obj.profiles) {
      const p = sanitizeProfile(raw);
      if (!p || seenIds.has(p.id) || seenTokens.has(p.token)) continue;
      seenIds.add(p.id);
      seenTokens.add(p.token);
      profiles.push(p);
    }
    let activeProfileId =
      typeof obj.activeProfileId === "string" ? obj.activeProfileId : null;
    if (activeProfileId !== null && !profiles.some((p) => p.id === activeProfileId)) {
      // active 指向不存在的档案（多半是手改文件）→ 回落到第一个档案      activeProfileId = profiles[0]?.id ?? null;
    }
    return { profiles, activeProfileId };
  }

  // 旧格式 { token } → 迁移为 1 号档案并写回
  if (typeof obj.token === "string" && obj.token.trim()) {
    const profile: BridgeProfile = {
      id: randomUUID(),
      label: "主账号",
      token: obj.token.trim(),
      createdAt: Date.now(),
    };
    const file: BridgeProfilesFile = {
      profiles: [profile],
      activeProfileId: profile.id,
    };
    try {
      writeProfilesFile(file);
    } catch {
      // 写回失败不拦读取：本次仍按迁移结果工作，下次再试
    }
    return file;
  }

  return { profiles: [], activeProfileId: null };
}


export type EffectiveBridgeProfiles = BridgeProfilesFile & {
  /** true 表示当前由环境变量临时单档案接管（文件档案让位中）。*/
  envDriven: boolean;
};

function envToken(): string | null {
  const fromEnv = process.env.YOYO_BRIDGE_TOKEN?.trim();
  return fromEnv ? fromEnv : null;
}

/** 当前生效的档案视图：环境变量在场时只有它一个档案且恒为当前。*/
export function effectiveProfiles(): EffectiveBridgeProfiles {
  const token = envToken();
  if (token) {
    const profile: BridgeProfile = {
      id: ENV_PROFILE_ID,
      label: "环境变量（临时）",
      token,
      createdAt: 0,
    };
    return { profiles: [profile], activeProfileId: profile.id, envDriven: true };
  }
  const file = readProfilesFile();
  return { ...file, envDriven: false };
}

const lastSeenByProfile = new Map<string, number>();

export function touchProfile(id: string): void {
  lastSeenByProfile.set(id, Date.now());
}

/** 最近一次带对令牌来访的时间（内存记录，重启丢失）；从未 → null。*/
export function profileLastSeenAt(id: string): number | null {
  return lastSeenByProfile.get(id) ?? null;
}

function tokenEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type BridgeAuth =
  | { state: "unconfigured" }
  | { state: "invalid" }
  | { state: "ok"; profile: BridgeProfile; isActive: boolean };

/** 桥端点鉴权：解析 presented 令牌到档案。命中即记 lastSeenAt。*/
export function authenticateBridge(presented: string | null): BridgeAuth {
  const eff = effectiveProfiles();
  if (eff.profiles.length === 0) return { state: "unconfigured" };
  if (!presented) return { state: "invalid" };
  for (const profile of eff.profiles) {
    if (tokenEquals(presented, profile.token)) {
      touchProfile(profile.id);
      return {
        state: "ok",
        profile,
        isActive: profile.id === eff.activeProfileId,
      };
    }
  }
  return { state: "invalid" };
}


function nextDefaultLabel(profiles: BridgeProfile[]): string {
  for (let n = 1; ; n += 1) {
    const label = `账号 ${n}`;
    if (!profiles.some((p) => p.label === label)) return label;
  }
}

export function addProfile(label?: string): BridgeProfile {
  const file = readProfilesFile();
  if (file.profiles.length >= MAX_BRIDGE_PROFILES) {
    throw new Error(
      `桥账号档案最多 ${MAX_BRIDGE_PROFILES} 个，已存满；先删掉不用的档案再新增`,
    );
  }
  const profile: BridgeProfile = {
    id: randomUUID(),
    label: label?.trim() ? label.trim() : nextDefaultLabel(file.profiles),
    token: randomBytes(24).toString("hex"),
    createdAt: Date.now(),
  };
  file.profiles.push(profile);
  if (!file.activeProfileId) file.activeProfileId = profile.id;
  writeProfilesFile(file);
  return profile;
}

export function renameProfile(id: string, label: string): BridgeProfile {
  const file = readProfilesFile();
  const profile = file.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("要改备注的档案不存在");
  const trimmed = label.trim();
  if (!trimmed) throw new Error("备注名不能为");
  profile.label = trimmed;
  writeProfilesFile(file);
  return profile;
}

export function activateProfile(id: string): BridgeProfile {
  const file = readProfilesFile();
  const profile = file.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("要设为当前的档案不存");
  file.activeProfileId = id;
  writeProfilesFile(file);
  return profile;
}

/** 删除档案。删掉的正是当前档案时，当前位置空置（不自动顶替
 * 由用户在管理页手动选下一个），避免误切到没配对好的账号。*/
export function deleteProfile(id: string): BridgeProfile {
  const file = readProfilesFile();
  const index = file.profiles.findIndex((p) => p.id === id);
  if (index < 0) throw new Error("要删除的档案不存");
  const [removed] = file.profiles.splice(index, 1);
  if (file.activeProfileId === id) file.activeProfileId = null;
  writeProfilesFile(file);
  return removed!;
}


/** 令牌掩码：前 4 + •••• + 后 4（与云端 Space 设置页口径一致）。 */
export function maskToken(token: string): string {
  if (token.length <= 8) return "••••";
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}
