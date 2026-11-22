// 一键诊断：收集 YoYo画布本地版 运行状态并生成脱敏报告（不输出完整令牌）。
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { maskToken } from "../local/bridge-profiles";
import { APP_ROOT, CLIENT_DIST, DATA_DIR, DB_PATH, PORT } from "../local/config";

const lines: string[] = [];
const out = (line = "") => {
  console.log(line);
  lines.push(line);
};

function findBin(name: string, bundledRel: string): string | null {
  const bundled = resolve(APP_ROOT, bundledRel);
  if (existsSync(bundled)) return bundled;
  return Bun.which(name);
}

async function probeHttp(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return `HTTP ${res.status}`;
  } catch (err) {
    return `不可达 (${err instanceof Error ? err.message : String(err)})`;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function stampNow(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  out("============================================================");
  out("  YoYo画布 · 本地版 诊断报告");
  out(`  时间: ${new Date().toLocaleString()}`);
  out(`  目录: ${APP_ROOT}`);
  out(`  系统: ${process.platform} / ${process.arch}`);
  out("============================================================");

  out("\n[1] 运行时");
  for (const [label, bin, rel] of [
    ["bun", "bun", "runtime/bun/bun.exe"],
    ["ffmpeg", "ffmpeg", "runtime/ffmpeg/ffmpeg.exe"],
    ["ffprobe", "ffprobe", "runtime/ffmpeg/ffprobe.exe"],
    ["cloudflared", "cloudflared", "runtime/cloudflared/cloudflared.exe"],
  ] as const) {
    const hit = findBin(bin, rel);
    out(`    ${label.padEnd(12)} ${hit ? `OK (${hit})` : "缺失"}`);
  }

  out("\n[2] 关键文件");
  const bridgeJsonPath = resolve(DATA_DIR, "bridge.json");
  const cfConfigPath = resolve(APP_ROOT, "runtime", "cloudflared", "config.yml");
  for (const [label, p] of [
    ["前端产物", resolve(CLIENT_DIST, "index.html")],
    ["SQLite 主库", DB_PATH],
    ["桥档案", bridgeJsonPath],
    ["隧道配置", cfConfigPath],
  ] as const) {
    out(`    ${label.padEnd(12)} ${existsSync(p) ? "OK" : "缺失"} (${p})`);
  }

  out(`\n[3] 本地服务 (127.0.0.1:${PORT})`);
  out(`    画布首页     ${await probeHttp(`http://127.0.0.1:${PORT}/`)}`);
  out(`    桥管理页     ${await probeHttp(`http://127.0.0.1:${PORT}/bridge-admin`)}`);

  out("\n[4] 桥账号档案（仅展示掩码）");
  if (process.env.YOYO_BRIDGE_TOKEN) {
    out(`    环境变量 YOYO_BRIDGE_TOKEN 已设置: ${maskToken(process.env.YOYO_BRIDGE_TOKEN)}`);
  }
  if (existsSync(bridgeJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(bridgeJsonPath, "utf8")) as {
        activeProfileId?: string | null;
        profiles?: { id: string; label: string; token: string }[];
      };
      const list = Array.isArray(raw.profiles) ? raw.profiles : [];
      out(`    档案数: ${list.length}，当前: ${raw.activeProfileId ?? "(未选)"}`);
      for (const p of list) {
        const mark = p.id === raw.activeProfileId ? "*" : " ";
        out(`    ${mark} ${p.label || p.id}  token=${maskToken(p.token ?? "")}`);
      }
    } catch (err) {
      out(`    解析 bridge.json 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    out("    尚无 bridge.json");
  }

  out("\n[5] 数据库与桥队列");
  if (existsSync(DB_PATH)) {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const mig = db
        .query("SELECT COUNT(*) AS cnt, MAX(name) AS latest FROM _local_migrations")
        .get() as { cnt: number; latest: string | null } | null;
      out(`    迁移进度: ${mig?.cnt ?? 0} 个 (最新: ${mig?.latest ?? "无"})`);
    } catch {
      out("    迁移表 _local_migrations 尚未建立");
    }
    try {
      const counts = db
        .query("SELECT status, COUNT(*) AS cnt FROM local_bridge_jobs GROUP BY status")
        .all() as { status: string; cnt: number }[];
      out(
        `    桥任务统计: ${counts.length ? counts.map((r) => `${r.status}=${r.cnt}`).join(" ") : "暂无任务"}`,
      );
      const failed = db
        .query(
          "SELECT kind, error, updated_at FROM local_bridge_jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5",
        )
        .all() as { kind: string; error: string | null; updated_at: number }[];
      for (const f of failed) {
        const ts = new Date(f.updated_at).toLocaleString();
        out(`      - [failed] ${f.kind} (${ts}): ${(f.error ?? "").slice(0, 120)}`);
      }
    } catch {
      out("    桥任务表 local_bridge_jobs 尚未建立");
    } finally {
      db.close();
    }
  } else {
    out("    尚无 app.db（首次启动后生成）");
  }

  const reportPath = resolve(APP_ROOT, `diagnose-${stampNow()}.txt`);
  writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
  out(`\n报告已保存: ${reportPath}`);
}

await main();
