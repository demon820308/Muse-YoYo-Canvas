// 特征测试：隧道向导（local/tunnel.ts，Wei 2026-11-22 09:05/09:10）：
// 覆盖：状态解析（已装/未装、已建/未建）、子域名 DNS 三态判定、
// config.yml 内容生成、参数白名单；另用假 cloudflared 替身脚本
// （fixtures/cloudflared，加入 PATH + 临时 HOME）验证真实 exec 路径
// 下的检测与建隧道捕获 ID。Windows 真机行为（winget/UAC/服务/
// 真实 login）不在本机验证范围，见 README 真机验收清单。
// 数据根指向临时目录，与真实 ./data 隔离

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = mkdtempSync(resolve(tmpdir(), "yoyo-tunnel-test-"));
process.env.YOYO_LOCAL_ROOT = root;

import type { ExecResult, TunnelDeps, TunnelWizard as TunnelWizardClass } from "../tunnel";

const tunnel = await import("../tunnel");
const {
  TunnelWizard,
  buildConfigYml,
  classifyDns,
  extractTunnelId,
  isValidHostname,
  parseServiceState,
  parseTunnelList,
  parseVersionOutput,
} = tunnel;

const FAKE_ID = "11111111-2222-3333-4444-555555555555";

describe("参数白名单与解析", () => {
  test("主机名白名单：合法通过、注入与畸形拒绝", () => {
    expect(isValidHostname("yoyo-bridge.ck971.cc.cd")).toBe(true);
    expect(isValidHostname("a.example.com")).toBe(true);
    expect(isValidHostname("bad host.example.com")).toBe(false);
    expect(isValidHostname("x.example.com; rm -rf /")).toBe(false);
    expect(isValidHostname("x.example.com`whoami`")).toBe(false);
    expect(isValidHostname("-bad.example.com")).toBe(false);
    expect(isValidHostname("localhost")).toBe(false);
    expect(isValidHostname("")).toBe(false);
  });

  test("版本解析：cloudflared --version 输出", () => {
    expect(
      parseVersionOutput("cloudflared version 2024.11.0 (built 2024-11-01)"),
    ).toBe("2024.11.0");
    expect(parseVersionOutput("command not found")).toBe(null);
  });

  test("隧道列表解析：命中 yoyo-bridge 取 ID、无则 null、坏 JSON 容错", () => {
    const out = JSON.stringify([
      { ID: "aaaaaaaa-0000-0000-0000-000000000000", NAME: "other" },
      { ID: FAKE_ID, NAME: "yoyo-bridge" },
    ]);
    expect(parseTunnelList(out, "yoyo-bridge")?.id).toBe(FAKE_ID);
    expect(parseTunnelList("[]", "yoyo-bridge")).toBe(null);
    expect(parseTunnelList("not json", "yoyo-bridge")).toBe(null);
  });

  test("create 输出取 ID", () => {
    expect(extractTunnelId(`Created tunnel yoyo-bridge with id ${FAKE_ID}`)).toBe(
      FAKE_ID,
    );
    expect(extractTunnelId("no id here")).toBe(null);
  });

  test("服务状态解析（sc query 输出", () => {
    expect(parseServiceState("STATE              : 4  RUNNING")).toBe("running");
    expect(parseServiceState("STATE              : 1  STOPPED")).toBe("stopped");
    expect(parseServiceState("[SC] OpenService FAILED 1060")).toBe("absent");
  });
});

describe("子域名 DNS 三态判定（★细则三）", () => {
  test("CNAME 指向 cfargotunnel → 已创建", () => {
    expect(
      classifyDns({
        cname: [`${FAKE_ID}.cfargotunnel.com`],
        a: [],
        aaaa: [],
      }),
    ).toBe("created");
    expect(
      classifyDns({
        cname: [`${FAKE_ID}.cfargotunnel.com.`],
        a: [],
        aaaa: [],
      }),
    ).toBe("created");
  });

  test("有其它记录 → 已被占用", () => {
    expect(classifyDns({ cname: ["other.example.com"], a: [], aaaa: [] })).toBe(
      "occupied",
    );
    expect(classifyDns({ cname: [], a: ["203.0.113.7"], aaaa: [] })).toBe(
      "occupied",
    );
    expect(classifyDns({ cname: [], a: [], aaaa: ["2001:db8::1"] })).toBe(
      "occupied",
    );
  });

  test("无任何记录 → 未创建可用", () => {
    expect(classifyDns({ cname: [], a: [], aaaa: [] })).toBe("free");
  });
});

describe("config.yml 生成", () => {
  test("主机名/ID/凭据路径正确、ingress 只放 /bridge/* 其余 404", () => {
    const yml = buildConfigYml({
      tunnelId: FAKE_ID,
      hostname: "yoyo-bridge.ck971.cc.cd",
      credentialsFile: "C:\\Users\\wei\\.cloudflared\\" + FAKE_ID + ".json",
      port: 3737,
    });
    expect(yml).toContain(`tunnel: ${FAKE_ID}`);
    expect(yml).toContain("yoyo-bridge.ck971.cc.cd");
    expect(yml).toContain(FAKE_ID + ".json");
    expect(yml).toContain("path: ^/bridge/.*");
    expect(yml).toContain("service: http://localhost:3737");
    expect(yml).toContain("service: http_status:404");
  });
});

function fakeDeps(overrides: Partial<TunnelDeps> = {}): TunnelDeps {
  const home = mkdtempSync(resolve(tmpdir(), "yoyo-tunnel-home-"));
  return {
    exec: async (cmd, args) => {
      if (args[0] === "--version") {
        return { code: 0, out: "cloudflared version 2024.11.0", err: "" };
      }
      if (args[0] === "tunnel" && args[1] === "list") {
        return { code: 0, out: "[]", err: "" };
      }
      return { code: 1, out: "", err: `unexpected ${cmd} ${args.join(" ")}` };
    },
    resolveDns: async () => ({ cname: [], a: [], aaaa: [] }),
    homeDir: () => home,
    platform: () => "linux",
    probe: async () => false,
    ...overrides,
  };
}

describe("状态自检（注入假依赖", () => {
  test("★细则一：已安装取到版本号、未安装 ok=false", async () => {
    const w = new TunnelWizard(fakeDeps());
    const installed = await w.detectInstalled();
    expect(installed.ok).toBe(true);
    expect(installed.version).toBe("2024.11.0");

    const w2 = new TunnelWizard(
      fakeDeps({
        exec: async () => ({ code: null, out: "", err: "not found" }),
      }),
    );
    expect((await w2.detectInstalled()).ok).toBe(false);
  });

  test("已建/未建：list 命中取 ID、无命中且无凭据文件为未建", async () => {
    const deps = fakeDeps();
    const w = new TunnelWizard(deps);
    expect(await w.detectTunnel()).toBe(null);

    const w2 = new TunnelWizard(
      fakeDeps({
        exec: async (_cmd, args) => {
          if (args[0] === "tunnel" && args[1] === "list") {
            return {
              code: 0,
              out: JSON.stringify([{ ID: FAKE_ID, NAME: "yoyo-bridge" }]),
              err: "",
            };
          }
          return { code: 0, out: "cloudflared version 2024.11.0", err: "" };
        },
      }),
    );
    expect((await w2.detectTunnel())?.id).toBe(FAKE_ID);
  });

  test("DNS 三态经注入解析器进 checkDns 并给出人话提示", async () => {
    const created = new TunnelWizard(
      fakeDeps({
        resolveDns: async () => ({
          cname: [`${FAKE_ID}.cfargotunnel.com`],
          a: [],
          aaaa: [],
        }),
      }),
    );
    const r1 = await created.checkDns("yoyo-bridge.ck971.cc.cd");
    expect(r1.state).toBe("created");
    expect(r1.detail).toContain("已创");

    const free = new TunnelWizard(fakeDeps());
    expect((await free.checkDns("yoyo-bridge.ck971.cc.cd")).state).toBe("free");
  });

  test("route 预检：已创建则不执行 route 命令（★细则三）", async () => {
    let routeCalled = false;
    const w = new TunnelWizard(
      fakeDeps({
        resolveDns: async () => ({
          cname: [`${FAKE_ID}.cfargotunnel.com`],
          a: [],
          aaaa: [],
        }),
        exec: async (_cmd, args) => {
          if (args[1] === "route") routeCalled = true;
          return { code: 0, out: "", err: "" };
        },
      }),
    );
    const job = w.startRoute("yoyo-bridge.ck971.cc.cd");
    await waitJob(w, job.id);
    expect(routeCalled).toBe(false);
    expect(job.status).toBe("done");
    expect(job.message).toContain("无需重复");
  });
});

async function waitJob(w: TunnelWizardClass, id: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const job = w.listJobs().find((j) => j.id === id);
    if (job && job.status !== "running") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job 超时未结");
}

describe("用 cloudflared 替身（PATH + 临时 HOME）", () => {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const savedMode = process.env.FAKE_CF_MODE;

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedMode === undefined) delete process.env.FAKE_CF_MODE;
    else process.env.FAKE_CF_MODE = savedMode;
  });

  function setupFake(mode: "with" | "without"): string {
    const binDir = mkdtempSync(resolve(tmpdir(), "yoyo-fake-bin-"));
    const home = mkdtempSync(resolve(tmpdir(), "yoyo-fake-home-"));
    if (process.platform !== "win32") {
      const script = readFileSync(
        resolve(import.meta.dir, "fixtures", "cloudflared"),
        "utf8",
      );
      const exe = join(binDir, "cloudflared");
      writeFileSync(exe, script, "utf8");
      chmodSync(exe, 0o755);
      process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`;
    }
    process.env.HOME = home;
    process.env.FAKE_CF_MODE = mode;
    return home;
  }

  function execFakeWin(
    home: string,
    cmd: string,
    args: string[],
  ): Promise<ExecResult> {
    if (cmd !== "cloudflared") return tunnel.defaultTunnelDeps.exec(cmd, args);
    const fakeScript = resolve(import.meta.dir, "fixtures", "fake-cloudflared.mjs");
    const proc = Bun.spawn([process.execPath, fakeScript], {
      env: { ...process.env, HOME: home, FAKE_CF_ARGS: JSON.stringify(args) },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    return Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]).then(([code, out, err]) => ({ code, out, err }));
  }

  // 注：Bun 的 os.homedir() 不认运行时改写 $HOME，故替身用例注入
  // homeDir 指向临时目录；Windows 下宿主 WIN_FALLBACK_BINS 会穿透 PATH
  // 因此用跨平台 bun 子进程替身隔离宿。?cloudflared.exe。?  
  function fakeWizard(home: string): TunnelWizardClass {
    return new TunnelWizard({
      ...tunnel.defaultTunnelDeps,
      homeDir: () => home,
      ...(process.platform === "win32"
        ? { exec: (cmd, args) => execFakeWin(home, cmd, args) }
        : {}),
    });
  }

  test("替身：版本检测 + 无隧道时未建", async () => {
    const home = setupFake("without");
    const w = fakeWizard(home);
    expect((await w.detectInstalled()).version).toBe("2024.11.0");
    expect(await w.detectTunnel()).toBe(null);
    expect(w.detectAuthorized()).toBe(false);
  }, 15_000);

  test("替身：list 有隧道时检出 ID；create 后凭据文件兜底检出", async () => {
    const home = setupFake("with");
    const w = fakeWizard(home);
    expect((await w.detectTunnel())?.id).toBe(FAKE_ID);

    process.env.FAKE_CF_MODE = "without";
    rmSync(join(home, ".cloudflared"), { recursive: true, force: true });
    expect(await w.detectTunnel()).toBe(null);
    const job = w.startCreate();
    await waitJob(w, job.id);
    expect(job.status).toBe("done");
    expect(existsSync(join(home, ".cloudflared", `${FAKE_ID}.json`))).toBe(true);
    expect((await w.detectTunnel())?.id).toBe(FAKE_ID);
  });
});

describe("防呆加固：多机隧道名、小写 JSON、防假绿与 530 识别", () => {
  test("tunnelNameForHostname 从子域名前缀派生隧道名", () => {
    expect(tunnel.tunnelNameForHostname("yoyo-bridge-home.ck971.cc.cd")).toBe(
      "yoyo-bridge-home",
    );
    expect(tunnel.tunnelNameForHostname("yoyo-bridge.ck971.cc.cd")).toBe(
      "yoyo-bridge",
    );
  });

  test("parseTunnelList 兼容小写 id/name 并忽略已删除隧道", () => {
    const out = JSON.stringify([
      { id: "00000000-0000-0000-0000-000000000001", name: "yoyo-bridge-home", deleted_at: "2026-11-22T00:00:00Z" },
      { id: FAKE_ID, name: "yoyo-bridge-home", deleted_at: "0001-01-01T00:00:00Z" },
    ]);
    expect(parseTunnelList(out, "yoyo-bridge-home")?.id).toBe(FAKE_ID);
  });

  test("classifyDns 校验目标隧道 ID：指向旧隧道判为 mismatch", () => {
    const otherId = "99999999-8888-7777-6666-555555555555";
    expect(
      classifyDns({ cname: [`${otherId}.cfargotunnel.com`], a: [], aaaa: [] }, FAKE_ID),
    ).toBe("mismatch");
    expect(
      classifyDns({ cname: [`${FAKE_ID}.cfargotunnel.com`], a: [], aaaa: [] }, FAKE_ID),
    ).toBe("created");
  });

  test("status 防假绿：云端存在但本机无凭据 json 时 tunnel.ok=false；公网 530 降级 DNS 为 mismatch", async () => {
    const w = new TunnelWizard(
      fakeDeps({
        exec: async (_cmd, args) => {
          if (args[0] === "tunnel" && args[1] === "list") {
            return {
              code: 0,
              out: JSON.stringify([{ id: FAKE_ID, name: "yoyo-bridge-home" }]),
              err: "",
            };
          }
          return { code: 0, out: "cloudflared version 2026.11.1", err: "" };
        },
        resolveDns: async () => ({
          cname: [`${FAKE_ID}.cfargotunnel.com`],
          a: [],
          aaaa: [],
        }),
        probeHttp: async () => 530,
      }),
    );
    const s = await w.status("yoyo-bridge-home.ck971.cc.cd", "tok");
    expect(s.tunnel.existsRemote).toBe(true);
    expect(s.tunnel.hasCredentials).toBe(false);
    expect(s.tunnel.ok).toBe(false);
    expect(s.e2e.ok).toBe(false);
    expect(s.e2e.needsDnsOverwrite).toBe(true);
    expect(s.dns.state).toBe("mismatch");
  });

  test("530 + Error 1033 识别为隧道未启动，不误降级 DNS 为 mismatch", async () => {
    expect(
      tunnel.parseCloudflareErrorCode(
        '<script>errorCode: 1033</script><span>1033</span>',
      ),
    ).toBe(1033);
    expect(tunnel.parseCloudflareErrorCode("Error 1016 Origin DNS Error")).toBe(
      1016,
    );
    expect(tunnel.parseCloudflareErrorCode("ok")).toBe(null);

    const w = new TunnelWizard(
      fakeDeps({
        platform: () => "win32",
        exec: async (cmd, args) => {
          if (cmd === "sc" && args[0] === "query") {
            return { code: 0, out: "STATE              : 1  STOPPED", err: "" };
          }
          if (args[0] === "tunnel" && args[1] === "list") {
            return {
              code: 0,
              out: JSON.stringify([{ id: FAKE_ID, name: "yoyo-bridge" }]),
              err: "",
            };
          }
          return { code: 0, out: "cloudflared version 2026.11.1", err: "" };
        },
        resolveDns: async () => ({
          cname: [`${FAKE_ID}.cfargotunnel.com`],
          a: [],
          aaaa: [],
        }),
        probeDetail: async () => ({ status: 530, cfErrorCode: 1033 }),
      }),
    );
    const s = await w.status("yoyo-bridge.ck971.cc.cd", "tok");
    expect(s.e2e.httpStatus).toBe(530);
    expect(s.e2e.needsDnsOverwrite).toBe(false);
    expect(s.dns.state).toBe("created");
  });

  test("ensureRunning：未配置跳过；服务停止时自动拉起；手动 stopRun 后不自动重启", async () => {
    let spawnCount = 0;
    const makeFakeChild = () => {
      const ee = new EventEmitter() as ChildProcess & {
        exitCode: number | null;
        kill: () => boolean;
      };
      ee.exitCode = null;
      ee.kill = () => {
        ee.exitCode = 0;
        ee.emit("close", 0);
        return true;
      };
      return ee;
    };

    const deps = fakeDeps({
      platform: () => "win32",
      exec: async (cmd, args) => {
        if (cmd === "sc" && args[0] === "query") {
          return { code: 0, out: "STATE              : 1  STOPPED", err: "" };
        }
        return { code: 0, out: "", err: "" };
      },
      spawnTunnel: () => {
        spawnCount += 1;
        return makeFakeChild();
      },
    });
    const w = new TunnelWizard(deps);

    // 未配置 config.yml 时不拉起
    expect(await w.ensureRunning("yoyo-bridge.ck971.cc.cd")).toBe(null);
    expect(spawnCount).toBe(0);

    // 写入 config.yml + 凭据 json 后自动拉起
    const cfDir = join(deps.homeDir(), ".cloudflared");
    mkdirSync(cfDir, { recursive: true });
    writeFileSync(join(cfDir, `${FAKE_ID}.json`), "{}", "utf8");
    writeFileSync(
      join(cfDir, "config.yml"),
      buildConfigYml({
        tunnelId: FAKE_ID,
        hostname: "yoyo-bridge.ck971.cc.cd",
        credentialsFile: join(cfDir, `${FAKE_ID}.json`),
      }),
      "utf8",
    );

    const msg = await w.ensureRunning("yoyo-bridge.ck971.cc.cd");
    expect(msg).toContain("已拉起");
    expect(spawnCount).toBe(1);

    // 正在运行时不重复拉起
    expect(await w.ensureRunning("yoyo-bridge.ck971.cc.cd")).toBe(null);
    expect(spawnCount).toBe(1);

    // 用户显式停止后不再自动拉起
    w.stopRun();
    expect(w.isManuallyStopped()).toBe(true);
    expect(await w.ensureRunning("yoyo-bridge.ck971.cc.cd")).toBe(null);
    expect(spawnCount).toBe(1);
  });

  test("diagnose 四态判定：unconfigured / unpaired / disconnected / connected", async () => {
    const deps = fakeDeps({
      platform: () => "win32",
      exec: async (cmd, args) => {
        if (cmd === "sc" && args[0] === "query") {
          return { code: 0, out: "STATE              : 4  RUNNING", err: "" };
        }
        if (args[0] === "tunnel" && args[1] === "list") {
          return {
            code: 0,
            out: JSON.stringify([{ id: FAKE_ID, name: "yoyo-bridge" }]),
            err: "",
          };
        }
        return { code: 0, out: "cloudflared version 2026.11.1", err: "" };
      },
      resolveDns: async () => ({
        cname: [`${FAKE_ID}.cfargotunnel.com`],
        a: [],
        aaaa: [],
      }),
      probeDetail: async () => ({ status: 200, cfErrorCode: null }),
      probe: async () => true,
    });
    const cfDir = join(deps.homeDir(), ".cloudflared");
    mkdirSync(cfDir, { recursive: true });
    writeFileSync(join(cfDir, "cert.pem"), "cert", "utf8");
    const w = new TunnelWizard(deps);

    // 1. 未配置（缺 config.yml 与凭据）
    const d1 = await w.diagnose("yoyo-bridge.ck971.cc.cd", {
      activeProfile: null,
      profileLastSeenAt: null,
      envDriven: false,
      telemetry: {
        processStartedAt: Date.now(),
        lastInvalidTokenAt: null,
        lastInactiveVisit: null,
      },
    });
    expect(d1.state).toBe("unconfigured");
    expect(d1.label).toBe("YoYo桥未配置");

    // 写入凭据与 config.yml
    writeFileSync(join(cfDir, `${FAKE_ID}.json`), "{}", "utf8");
    writeFileSync(
      join(cfDir, "config.yml"),
      buildConfigYml({
        tunnelId: FAKE_ID,
        hostname: "yoyo-bridge.ck971.cc.cd",
        credentialsFile: join(cfDir, `${FAKE_ID}.json`),
      }),
      "utf8",
    );

    // 2. 本地就绪但从未配对 → Muse YoYo桥未配对
    const d2 = await w.diagnose("yoyo-bridge.ck971.cc.cd", {
      activeProfile: { id: "p1", label: "主账号", token: "tok", everConnectedAt: null },
      profileLastSeenAt: null,
      envDriven: false,
      telemetry: {
        processStartedAt: Date.now(),
        lastInvalidTokenAt: null,
        lastInactiveVisit: null,
      },
    });
    expect(d2.state).toBe("unpaired");
    expect(d2.label).toBe("Muse YoYo桥未配对");

    // 3. 曾配对但收到 401 错令牌 → YoYo桥连接已断开
    const d3 = await w.diagnose("yoyo-bridge.ck971.cc.cd", {
      activeProfile: { id: "p1", label: "主账号", token: "tok", everConnectedAt: 1000 },
      profileLastSeenAt: null,
      envDriven: false,
      telemetry: {
        processStartedAt: Date.now(),
        lastInvalidTokenAt: Date.now(),
        lastInactiveVisit: null,
      },
    });
    expect(d3.state).toBe("disconnected");
    expect(d3.label).toBe("YoYo桥连接已断开");

    // 4. 曾配对且隧道 200 + 近期心跳 → YoYo桥已连接
    const d4 = await w.diagnose("yoyo-bridge.ck971.cc.cd", {
      activeProfile: { id: "p1", label: "主账号", token: "tok", everConnectedAt: 1000 },
      profileLastSeenAt: Date.now(),
      envDriven: false,
      telemetry: {
        processStartedAt: Date.now(),
        lastInvalidTokenAt: null,
        lastInactiveVisit: null,
      },
    });
    expect(d4.state).toBe("connected");
    expect(d4.label).toBe("YoYo桥已连接");

    // 5. 刚启动隧道但公网尚未连通（预热期）→ YoYo桥连接中…
    const depsConnecting = fakeDeps({
      ...deps,
      probeDetail: async () => ({ status: 530, cfErrorCode: 1033 }),
      probe: async () => false,
      spawnTunnel: () => {
        const ee = new EventEmitter() as ChildProcess & {
          exitCode: number | null;
          kill: () => boolean;
        };
        ee.exitCode = null;
        ee.kill = () => true;
        return ee;
      },
    });
    const cf2 = join(depsConnecting.homeDir(), ".cloudflared");
    mkdirSync(cf2, { recursive: true });
    writeFileSync(join(cf2, "cert.pem"), "cert", "utf8");
    writeFileSync(join(cf2, `${FAKE_ID}.json`), "{}", "utf8");
    writeFileSync(
      join(cf2, "config.yml"),
      buildConfigYml({
        tunnelId: FAKE_ID,
        hostname: "yoyo-bridge.ck971.cc.cd",
        credentialsFile: join(cf2, `${FAKE_ID}.json`),
      }),
      "utf8",
    );
    const wConn = new TunnelWizard(depsConnecting);
    wConn.startRun("yoyo-bridge.ck971.cc.cd");
    const d5 = await wConn.diagnose("yoyo-bridge.ck971.cc.cd", {
      activeProfile: { id: "p1", label: "主账号", token: "tok", everConnectedAt: 1000 },
      profileLastSeenAt: null,
      envDriven: false,
      telemetry: {
        processStartedAt: Date.now(),
        lastInvalidTokenAt: null,
        lastInactiveVisit: null,
      },
    });
    expect(d5.state).toBe("connecting");
    expect(d5.label).toBe("YoYo桥连接中…");
  });
});
