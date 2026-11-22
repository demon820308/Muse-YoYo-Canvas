import { PORT } from "./config";

export const TUNNEL_NAME = "yoyo-bridge";
export const DEFAULT_HOSTNAME = "yoyo-bridge.ck971.cc.cd";
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 主机名白名单：字母数字、点、连字符，至少含一个点，段不以 - 开头或结尾。 */
export function isValidHostname(value: string): boolean {
  const h = value.trim().toLowerCase();
  if (!h || h.length > 253 || !h.includes(".")) return false;
  return h
    .split(".")
    .every((seg) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(seg));
}

export function parseVersionOutput(out: string): string | null {
  const m =
    out.match(/cloudflared\s+version\s+([0-9][^\s]*)/i) ??
    out.match(/\b(\d{4}\.\d+\.\d+)\b/);
  return m ? m[1]! : null;
}

export type TunnelInfo = { id: string; name: string };

export function parseTunnelList(out: string, name: string): TunnelInfo | null {
  try {
    const rows = JSON.parse(out) as { ID?: string; NAME?: string }[];
    if (!Array.isArray(rows)) return null;
    const hit = rows.find((r) => r.NAME === name && typeof r.ID === "string");
    return hit ? { id: hit.ID!, name: hit.NAME! } : null;
  } catch {
    return null;
  }
}

export function extractTunnelId(text: string): string | null {
  const m = text.match(UUID_RE);
  return m ? m[0] : null;
}

export type DnsRecords = { cname: string[]; a: string[]; aaaa: string[] };
export type DnsState = "created" | "occupied" | "free";

/** 子域名三态：CNAME 指向 *.cfargotunnel.com = 已创建（隧道记录）；
 * 有任何其它记录 = 已被占用；无记录 = 未创建可用。 */
export function classifyDns(records: DnsRecords): DnsState {
  const isTunnel = records.cname.some((c) =>
    c.toLowerCase().replace(/\.$/, "").endsWith(".cfargotunnel.com"),
  );
  if (isTunnel) return "created";
  if (records.cname.length || records.a.length || records.aaaa.length) {
    return "occupied";
  }
  return "free";
}

export function buildConfigYml(args: {
  tunnelId: string;
  hostname: string;
  credentialsFile: string;
  port?: number;
}): string {
  const port = args.port ?? PORT;
  return [
    "# 由本地画布桥管理页「隧道向导」生成（口径同 runtime/cloudflared 模板",
    "# ingress 纪律：只把 /bridge/* 转发到本地画布后端，其余一律 404",
    "",
    `tunnel: ${args.tunnelId}`,
    `credentials-file: ${args.credentialsFile}`,
    "protocol: http2",
    "",
    "ingress:",
    `  - hostname: ${args.hostname}`,
    "    path: ^/bridge/.*",
    `    service: http://localhost:${port}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

export function parseServiceState(out: string): "running" | "stopped" | "absent" {
  if (/STATE\s*:\s*\d+\s+RUNNING/i.test(out)) return "running";
  if (/STATE\s*:/i.test(out)) return "stopped";
  return "absent";
}
