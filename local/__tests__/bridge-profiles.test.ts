// 特征测试：桥账号档案（多账号手动切换，Wei 2026-11-22 08:40 定版）。
// 刻画 local/bridge-profiles.ts 的行为：旧格式迁移、多档案 CRUD、
// 当前档案门控的鉴权解析、环境变量临时单档案、令牌掩码、上限。
// 数据根指向临时目录，与真实 ./data 隔离。

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { atomicWriteFileSync } from "../atomic-write";

const prevRoot = process.env.YOYO_LOCAL_ROOT;
const root = mkdtempSync(resolve(tmpdir(), "yoyo-bridge-profiles-"));
process.env.YOYO_LOCAL_ROOT = root;
delete process.env.YOYO_BRIDGE_TOKEN;

const profiles = await import("../bridge-profiles");

const BRIDGE_FILE = resolve(root, "bridge.json");

beforeEach(() => {
  process.env.YOYO_LOCAL_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.YOYO_LOCAL_ROOT;
  else process.env.YOYO_LOCAL_ROOT = prevRoot;
});

function resetFile(content?: unknown): void {
  if (content === undefined) {
    rmSync(BRIDGE_FILE, { force: true });
  } else {
    writeFileSync(BRIDGE_FILE, JSON.stringify(content), "utf8");
  }
}

describe("未配置与旧格式迁移", () => {
  test("无 bridge.json 时未配置（桥端点据此回 503）", () => {
    resetFile();
    expect(profiles.effectiveProfiles().profiles).toEqual([]);
    expect(profiles.authenticateBridge("anything").state).toBe("unconfigured");
    expect(profiles.authenticateBridge(null).state).toBe("unconfigured");
  });

  test("旧格式 { token } 自动迁移为 1 号档案并写回、即为当前", () => {
    resetFile({ token: "legacy-token-123" });
    const file = profiles.readProfilesFile();
    expect(file.profiles.length).toBe(1);
    const first = file.profiles[0]!;
    expect(first.label).toBe("主账号");
    expect(first.token).toBe("legacy-token-123");
    expect(file.activeProfileId).toBe(first.id);
    // 已写回新格式
    const onDisk = JSON.parse(readFileSync(BRIDGE_FILE, "utf8")) as {
      profiles?: unknown;
    };
    expect(Array.isArray(onDisk.profiles)).toBe(true);
    // 迁移后的令牌鉴权为 ok 且当前
    const auth = profiles.authenticateBridge("legacy-token-123");
    expect(auth.state).toBe("ok");
    if (auth.state === "ok") expect(auth.isActive).toBe(true);
  });

  test("损坏的 bridge.json 按未配置处理，不抛错", () => {
    writeFileSync(BRIDGE_FILE, "{not json", "utf8");
    expect(profiles.readProfilesFile().profiles).toEqual([]);
    expect(profiles.authenticateBridge("x").state).toBe("unconfigured");
  });
});

describe("多档案 CRUD 与门控解析", () => {
  test("新增档案：令牌为 48 位十六进制、首个自动成为当前、第二个不是", () => {
    resetFile();
    const a = profiles.addProfile("账号甲");
    expect(a.token).toMatch(/^[0-9a-f]{48}$/);
    const b = profiles.addProfile();
    expect(b.label).toBe("账号 1");
    const file = profiles.readProfilesFile();
    expect(file.profiles.length).toBe(2);
    expect(file.activeProfileId).toBe(a.id);
    const authB = profiles.authenticateBridge(b.token);
    expect(authB.state).toBe("ok");
    if (authB.state === "ok") expect(authB.isActive).toBe(false);
  });

  test("未知令牌与空令牌都是 invalid（桥端点据此回 401）", () => {
    expect(profiles.authenticateBridge("no-such-token").state).toBe("invalid");
    expect(profiles.authenticateBridge(null).state).toBe("invalid");
    expect(profiles.authenticateBridge("").state).toBe("invalid");
  });

  test("设为当前后门控翻转；改备注落盘", () => {
    const file = profiles.readProfilesFile();
    const target = file.profiles[1]!;
    profiles.activateProfile(target.id);
    const auth = profiles.authenticateBridge(target.token);
    expect(auth.state).toBe("ok");
    if (auth.state === "ok") expect(auth.isActive).toBe(true);
    profiles.renameProfile(target.id, "备用账号");
    expect(
      profiles.readProfilesFile().profiles.find((p) => p.id === target.id)?.label,
    ).toBe("备用账号");
  });

  test("删除当前档案后当前位置空置，被删令牌转 invalid", () => {
    const file = profiles.readProfilesFile();
    const activeId = file.activeProfileId!;
    const active = file.profiles.find((p) => p.id === activeId)!;
    profiles.deleteProfile(activeId);
    const after = profiles.readProfilesFile();
    expect(after.profiles.length).toBe(1);
    expect(after.activeProfileId).toBeNull();
    expect(profiles.authenticateBridge(active.token).state).toBe("invalid");
    // 剩下的档案是已知但非当前（门控据此回 inactive）
    const rest = profiles.authenticateBridge(after.profiles[0]!.token);
    expect(rest.state).toBe("ok");
    if (rest.state === "ok") expect(rest.isActive).toBe(false);
  });

  test("档案上限 8 个，第 9 个报人话错误", () => {
    resetFile();
    for (let i = 0; i < profiles.MAX_BRIDGE_PROFILES; i += 1) {
      profiles.addProfile();
    }
    expect(() => profiles.addProfile()).toThrow(/最多 8 个/);
  });
});

describe("环境变量临时单档案", () => {
  test("YOYO_BRIDGE_TOKEN 在场时只认它且恒为当前，文件档案让位", () => {
    resetFile();
    const fileProfile = profiles.addProfile("文件档案");
    process.env.YOYO_BRIDGE_TOKEN = "env-token-abc";
    try {
      const eff = profiles.effectiveProfiles();
      expect(eff.envDriven).toBe(true);
      expect(eff.profiles.length).toBe(1);
      const authEnv = profiles.authenticateBridge("env-token-abc");
      expect(authEnv.state).toBe("ok");
      if (authEnv.state === "ok") expect(authEnv.isActive).toBe(true);
      expect(profiles.authenticateBridge(fileProfile.token).state).toBe("invalid");
      // 环境变量不落盘：文件里仍然只有文件档案
      expect(existsSync(BRIDGE_FILE)).toBe(true);
      expect(profiles.readProfilesFile().profiles.length).toBe(1);
    } finally {
      delete process.env.YOYO_BRIDGE_TOKEN;
    }
    // 移除后文件档案恢复
    expect(profiles.authenticateBridge(fileProfile.token).state).toBe("ok");
  });
});

describe("掩码与最近在线", () => {
  test("maskToken 只露头尾各 4 位", () => {
    expect(profiles.maskToken("abcdef1234567890wxyz")).toBe("abcd••••wxyz");
    expect(profiles.maskToken("short")).toBe("••••");
  });

  test("鉴权命中即记 lastSeenAt，未命中不记", () => {
    resetFile();
    const p = profiles.addProfile("在线测试");
    expect(profiles.profileLastSeenAt(p.id)).toBeNull();
    profiles.authenticateBridge("wrong-token");
    expect(profiles.profileLastSeenAt(p.id)).toBeNull();
    profiles.authenticateBridge(p.token);
    expect(profiles.profileLastSeenAt(p.id)).not.toBeNull();
  });

  test("atomicWriteFileSync 覆盖写入且不留临时文件", () => {
    const target = resolve(root, "atomic-check.json");
    atomicWriteFileSync(target, "v1");
    atomicWriteFileSync(target, "v2");
    expect(readFileSync(target, "utf8")).toBe("v2");
    const leftovers = readdirSync(root).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
