import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const a = JSON.parse(process.env.FAKE_CF_ARGS || "[]");
const id = "11111111-2222-3333-4444-555555555555";
const home = process.env.HOME;

if (a[0] === "--version") {
  console.log("cloudflared version 2024.11.0 (built 2024-11-01)");
  process.exit(0);
}
if (a[0] === "tunnel" && a[1] === "list") {
  console.log(
    process.env.FAKE_CF_MODE === "with"
      ? JSON.stringify([
          {
            ID: id,
            NAME: "yoyo-bridge",
            CREATED_AT: "2026-01-01T00:00:00Z",
            CONNECTIONS: [],
          },
        ])
      : "[]",
  );
  process.exit(0);
}
if (a[0] === "tunnel" && a[1] === "create") {
  mkdirSync(join(home, ".cloudflared"), { recursive: true });
  writeFileSync(
    join(home, ".cloudflared", `${id}.json`),
    JSON.stringify({ AccountTag: "fake", TunnelSecret: "fake", TunnelID: id }),
  );
  console.log(`Created tunnel ${a[2]} with id ${id}`);
  process.exit(0);
}
if (a[0] === "tunnel" && a[1] === "route") {
  appendFileSync(join(home, "route-dns.log"), `${a.join(" ")}\n`);
  console.log(`Added CNAME ${a[4]} which will route to this tunnel`);
  process.exit(0);
}
process.stderr.write(`fake cloudflared: unhandled args: ${a.join(" ")}`);
process.exit(1);
