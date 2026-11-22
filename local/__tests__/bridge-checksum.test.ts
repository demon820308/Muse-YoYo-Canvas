import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = mkdtempSync(resolve(tmpdir(), "yoyo-bridge-checksum-"));
process.env.YOYO_LOCAL_ROOT = root;
process.env.HATCH_SPACE_BLOB_DIR = resolve(root, "blobs");
process.env.YOYO_BRIDGE_TOKEN = "test-checksum-token";

const { openDb } = await import("../db");
const { createCtx } = await import("../ctx");
const { handleBridge } = await import("../bridge");
const { ensureBridgeJobsTable, createBridgeJob } = await import(
  "../../server/src/actions/bridge-jobs"
);
const schema = await import("../../server/src/schema");

const { db } = openDb();
await ensureBridgeJobsTable(db as never);
const ctx = createCtx(db);

const projectDir = resolve(root, "yoyo-canvas-projects", "proj-1");
mkdirSync(projectDir, { recursive: true });
const now = new Date();
await db.insert(schema.projects).values({
  id: "proj-1",
  name: "checksum-proj",
  workspaceDir: projectDir,
  createdAt: now,
  updatedAt: now,
});
await db.insert(schema.canvasNodes).values({
  id: "node-1",
  projectId: "proj-1",
  type: "image",
  title: "img",
  x: 0,
  y: 0,
  width: 320,
  height: 240,
  content: "",
  genStatus: "working",
  createdAt: now,
  updatedAt: now,
});
const { jobId } = await createBridgeJob(db as never, {
  projectId: "proj-1",
  nodeId: "node-1",
  kind: "task-image",
  expectsAction: "completeImageGeneration",
  dedupeKey: "dedupe-checksum-1",
  payload: {},
});

describe("/bridge/result 权威哈希校验（第 8 条）", () => {
  test("畸形 x-content-sha256 拒绝（400）", async () => {
    const url = "http://127.0.0.1/bridge/result";
    const req = new Request(url, {
      method: "POST",
      headers: {
        "x-bridge-token": "test-checksum-token",
        "x-job-id": jobId,
        "x-file-name": "out.png",
        "x-content-sha256": "not-a-sha256",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const res = await handleBridge(req, new URL(url), { db, ctx });
    expect(res?.status).toBe(400);
    expect(await res?.json()).toEqual({ error: "invalid_checksum_header" });
  });

  test("内容篡改但大小不变的样本被识别拒绝（422），且不落盘", async () => {
    const good = new Uint8Array([10, 20, 30, 40]);
    const tampered = new Uint8Array([10, 20, 30, 99]); // 等长但篡改
    const expectedHash = createHash("sha256").update(good).digest("hex");

    const url = "http://127.0.0.1/bridge/result";
    const req = new Request(url, {
      method: "POST",
      headers: {
        "x-bridge-token": "test-checksum-token",
        "x-job-id": jobId,
        "x-file-name": "tampered.png",
        "x-content-sha256": expectedHash,
      },
      body: tampered,
    });
    const res = await handleBridge(req, new URL(url), { db, ctx });
    expect(res?.status).toBe(422);
    expect(await res?.json()).toEqual({ error: "checksum_mismatch" });
    expect(existsSync(resolve(projectDir, "tampered.png"))).toBe(false);
  });
});
