import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx } from "@hatch/space-sdk";
import { Contracts } from "@space/privileged";
import * as schema from "../../schema";
import type { Db } from "../contracts";
import { MediaEditActions } from "../media-edit";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "..", "..", "drizzle");

async function makeDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) await client.execute(trimmed);
    }
  }
  return drizzle(client, { schema }) as Db;
}

const PROJ_DIR = resolve(tmpdir(), "yoyo-upload-test-proj-1");

function makeCtx(db: Db): Ctx {
  const store = new Map<string, { data: Uint8Array; contentType: string }>();
  const blobs: Ctx["blobs"] = {
    async put(key, data, opts) {
      const bytes =
        data instanceof Uint8Array
          ? data
          : typeof data === "string"
            ? Buffer.from(data)
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(await data.arrayBuffer());
      store.set(key, {
        data: bytes,
        contentType: opts?.contentType ?? "application/octet-stream",
      });
    },
    async getUrl(key) {
      return store.has(key) ? `/blobs/${key}` : "";
    },
    async delete(key) {
      store.delete(key);
    },
    async head(key) {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        key,
        contentType: hit.contentType,
        size: hit.data.byteLength,
        sizeBytes: hit.data.byteLength,
        etag: "etag",
        visibility: "private",
        createdAtMs: 0,
        updatedAtMs: 0,
      };
    },
    async list(prefix = "") {
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({
          key,
          contentType: store.get(key)!.contentType,
          size: store.get(key)!.data.byteLength,
          sizeBytes: store.get(key)!.data.byteLength,
          etag: "etag",
          visibility: "private" as const,
          createdAtMs: 0,
          updatedAtMs: 0,
        }));
    },
  };
  const executePrivileged: Ctx["executePrivileged"] = async (contract, args) => {
    if (contract.name === Contracts.writeProjectFile.name) {
      const a = args as { projectDir?: string; fileName: string };
      return { path: resolve(a.projectDir || PROJ_DIR, a.fileName) } as never;
    }
    if (contract.name === Contracts.probeMediaFile.name) {
      return { width: 1280, height: 720, durationSeconds: 3 } as never;
    }
    if (contract.name === Contracts.makePoster.name) {
      const a = args as { outputDir: string; posterName: string };
      return { posterPath: resolve(a.outputDir, a.posterName) } as never;
    }
    if (contract.name === Contracts.makePlaybackProxy.name) {
      const a = args as { outputDir: string; fileName: string };
      return { path: resolve(a.outputDir, a.fileName) } as never;
    }
    if (contract.name === Contracts.readMediaFile.name) {
      return {
        dataBase64: Buffer.from("media").toString("base64"),
        contentType: "image/jpeg",
      } as never;
    }
    throw new Error(`unexpected privileged contract: ${contract.name}`);
  };
  return {
    spaceDir: "/tmp/space",
    db: () => db as never,
    blobs,
    executePrivileged,
    emit() {},
    invalidateQueries() {},
  } as unknown as Ctx;
}

describe("canvas upload records asset automatically", () => {
  test("uploadMedia 自动把图片、视频（含封面）和音频写入该项目资产库", async () => {
    const db = await makeDb();
    await db.insert(schema.projects).values({
      id: "proj-1",
      name: "测试项目",
      workspaceDir: PROJ_DIR,
    });
    const ctx = makeCtx(db);
    const dataBase64 = Buffer.from("hello").toString("base64");

    const imgRes = await MediaEditActions.uploadMedia.handler(ctx, {
      projectId: "proj-1",
      kind: "image",
      fileName: "photo.png",
      mimeType: "image/png",
      dataBase64,
      x: 0,
      y: 0,
      width: 320,
      height: 240,
    });
    const vidRes = await MediaEditActions.uploadMedia.handler(ctx, {
      projectId: "proj-1",
      kind: "video",
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      dataBase64,
      x: 400,
      y: 0,
      width: 420,
      height: 236,
    });
    const audRes = await MediaEditActions.uploadMedia.handler(ctx, {
      projectId: "proj-1",
      kind: "audio",
      fileName: "bgm.mp3",
      mimeType: "audio/mpeg",
      dataBase64,
      x: 0,
      y: 400,
      width: 340,
      height: 120,
    });

    const assets = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.projectId, "proj-1"));

    expect(assets).toHaveLength(3);
    const imgAsset = assets.find((a) => a.sourceNodeId === imgRes.node.id);
    expect(imgAsset?.kind).toBe("image");
    expect(imgAsset?.title).toBe("photo.png");
    expect(imgAsset?.mediaBlobKey).toBe(imgRes.node.mediaBlobKey);
    expect(imgAsset?.filePath).toBe(imgRes.filePath);

    const vidAsset = assets.find((a) => a.sourceNodeId === vidRes.node.id);
    expect(vidAsset?.kind).toBe("video");
    expect(vidAsset?.title).toBe("clip.mp4");
    expect(vidAsset?.posterBlobKey).toBe(vidRes.node.posterBlobKey);
    expect(vidAsset?.posterBlobKey).toBeTruthy();

    const audAsset = assets.find((a) => a.sourceNodeId === audRes.node.id);
    expect(audAsset?.kind).toBe("audio");
    expect(audAsset?.title).toBe("bgm.mp3");
    expect(audAsset?.mimeType).toBe("audio/mpeg");
  });

  test("replaceNodeMedia 把图片/视频节点上传写入或更新资产库，跳过 image-mask", async () => {
    const db = await makeDb();
    await db.insert(schema.projects).values({
      id: "proj-1",
      name: "测试项目",
      workspaceDir: PROJ_DIR,
    });
    const now = new Date();
    await db.insert(schema.canvasNodes).values([
      {
        id: "blank-vid",
        projectId: "proj-1",
        type: "video",
        title: "空白视频",
        x: 0,
        y: 0,
        width: 420,
        height: 236,
        content: "",
        prompt: "",
        status: "idle",
        hidden: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "mask-1",
        projectId: "proj-1",
        type: "image-mask",
        title: "蒙版",
        x: 0,
        y: 300,
        width: 320,
        height: 320,
        content: "",
        prompt: "",
        status: "idle",
        hidden: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const ctx = makeCtx(db);
    const dataBase64 = Buffer.from("video-bytes").toString("base64");

    await MediaEditActions.replaceNodeMedia.handler(ctx, {
      nodeId: "blank-vid",
      fileName: "first.mp4",
      mimeType: "video/mp4",
      dataBase64,
    });
    await MediaEditActions.replaceNodeMedia.handler(ctx, {
      nodeId: "blank-vid",
      fileName: "second.mp4",
      mimeType: "video/mp4",
      dataBase64,
    });
    await MediaEditActions.replaceNodeMedia.handler(ctx, {
      nodeId: "mask-1",
      fileName: "mask.png",
      mimeType: "image/png",
      dataBase64,
    });

    const assets = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.projectId, "proj-1"));

    expect(assets).toHaveLength(1);
    expect(assets[0]?.kind).toBe("video");
    expect(assets[0]?.title).toBe("second.mp4");
    expect(assets[0]?.sourceNodeId).toBe("blank-vid");
  });
});
