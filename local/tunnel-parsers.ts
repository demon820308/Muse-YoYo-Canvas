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

/** 从子域名前缀派生隧道名（如 yoyo-bridge-home.ck971.cc.cd -> yoyo-bridge-home），默认回退 yoyo-bridge。 */
export function tunnelNameForHostname(hostname: string): string {
  const norm = hostname.trim().toLowerCase();
  if (!isValidHostname(norm)) return TUNNEL_NAME;
  const prefix = norm.split(".")[0];
  return prefix && prefix.length > 0 ? prefix : TUNNEL_NAME;
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
    const rows = JSON.parse(out) as {
      ID?: string;
      NAME?: string;
      id?: string;
      name?: string;
      deleted_at?: string;
    }[];
    if (!Array.isArray(rows)) return null;
    const hit = rows.find((r) => {
      const rName = r.NAME ?? r.name;
      const rId = r.ID ?? r.id;
      const deleted =
        typeof r.deleted_at === "string" &&
        r.deleted_at !== "" &&
        !r.deleted_at.startsWith("0001-01-01");
      return !deleted && rName === name && typeof rId === "string" && rId.length > 0;
    });
    if (!hit) return null;
    return { id: (hit.ID ?? hit.id)!, name: (hit.NAME ?? hit.name)! };
  } catch {
    return null;
  }
}

export function extractTunnelId(text: string): string | null {
  const m = text.match(UUID_RE);
  return m ? m[0] : null;
}

export type DnsRecords = { cname: string[]; a: string[]; aaaa: string[] };
export type DnsState = "created" | "mismatch" | "occupied" | "free";

/** 子域名四态：
 * - 若传入 expectedTunnelId：CNAME 精确命中 `<id>.cfargotunnel.com` = created；命中其它 `*.cfargotunnel.com` = mismatch；
 * - 未传 expectedTunnelId：任意 `*.cfargotunnel.com` = created；
 * - 有任何其它记录 = occupied；无记录 = free。 */
export function classifyDns(
  records: DnsRecords,
  expectedTunnelId?: string | null,
): DnsState {
  const normCnames = records.cname.map((c) => c.toLowerCase().replace(/\.$/, ""));
  const tunnelCnames = normCnames.filter((c) => c.endsWith(".cfargotunnel.com"));
  if (tunnelCnames.length > 0) {
    if (expectedTunnelId) {
      const target = `${expectedTunnelId.toLowerCase()}.cfargotunnel.com`;
      return tunnelCnames.includes(target) ? "created" : "mismatch";
    }
    return "created";
  }
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

/** 从 Cloudflare 530 错误页提取错误码（1033=隧道未连上边缘，1016=Origin DNS 错误）。 */
export function parseCloudflareErrorCode(body: string): number | null {
  const m =
    body.match(/errorCode\s*:\s*(\d{4})\b/) ??
    body.match(/data-translate="error"[^>]*>[^<]*<\/span>\s*<span>(\d{4})<\/span>/i) ??
    body.match(/\bError\s+(\d{4})\b/i);
  return m ? Number(m[1]) : null;
}
