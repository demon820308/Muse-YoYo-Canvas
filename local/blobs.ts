// [yoyo-local] Blob 本地实现：目录 ./data/blobs/，对象布局与平台一致——
// objects/<sha256(key)[:2]>/<sha256(key)>，另存同名 .meta.json 记录
// contentType 与尺寸。布局一致使特权层 mirrorBlobToFile /
// buildProjectPackage 的 blob 读取（resolveBlobObjectPath，根由
// HATCH_SPACE_BLOB_DIR 指到本目录）零改动可用。
// getUrl 返回 /blobs/<key>，由 local/app.ts 的静态路由出字节。

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  BlobClient,
  BlobMetadata,
  BlobPutData,
  BlobPutOptions,
} from "@hatch/space-sdk";
import { atomicWriteFileSync } from "./atomic-write";
import { BLOBS_DIR } from "./config";

type BlobMeta = {
  key: string;
  contentType: string;
  size: number;
  createdAtMs: number;
  updatedAtMs: number;
};

function objectIdFor(key: string): string {
  const segments = key.split("/");
  if (
    key.startsWith("/") ||
    key.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error("invalid blob key");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function objectPath(key: string): string {
  const id = objectIdFor(key);
  return resolve(BLOBS_DIR, "objects", id.slice(0, 2), id);
}

function metaPath(key: string): string {
  return `${objectPath(key)}.meta.json`;
}

function readMeta(key: string): BlobMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(key), "utf8")) as BlobMeta;
  } catch {
    return null;
  }
}

async function toBytes(data: BlobPutData): Promise<Buffer> {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function toMetadata(meta: BlobMeta): BlobMetadata {
  return {
    key: meta.key,
    contentType: meta.contentType,
    size: meta.size,
    sizeBytes: meta.size,
    etag: objectIdFor(meta.key),
    visibility: "private",
    createdAtMs: meta.createdAtMs,
    updatedAtMs: meta.updatedAtMs,
  };
}

export function createBlobClient(): BlobClient {
  return {
    async put(key, data, options?: BlobPutOptions) {
      const bytes = await toBytes(data);
      const target = objectPath(key);
      mkdirSync(dirname(target), { recursive: true });
      const previous = readMeta(key);
      const now = Date.now();
      atomicWriteFileSync(target, bytes);
      const meta: BlobMeta = {
        key,
        contentType: options?.contentType ?? previous?.contentType ?? "application/octet-stream",
        size: bytes.byteLength,
        createdAtMs: previous?.createdAtMs ?? now,
        updatedAtMs: now,
      };
      atomicWriteFileSync(metaPath(key), JSON.stringify(meta));
    },
    async getUrl(key) {
      objectIdFor(key); // 校验 key 形状
      return `/blobs/${key.split("/").map(encodeURIComponent).join("/")}`;
    },
    async delete(key) {
      rmSync(objectPath(key), { force: true });
      rmSync(metaPath(key), { force: true });
    },
    async head(key) {
      const meta = readMeta(key);
      return meta ? toMetadata(meta) : null;
    },
    async list(prefix?: string) {
      const out: BlobMetadata[] = [];
      const objectsRoot = join(BLOBS_DIR, "objects");
      let shards: string[] = [];
      try {
        shards = readdirSync(objectsRoot);
      } catch {
        return out;
      }
      for (const shard of shards) {
        let files: string[] = [];
        try {
          files = readdirSync(join(objectsRoot, shard));
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith(".meta.json")) continue;
          try {
            const meta = JSON.parse(
              readFileSync(join(objectsRoot, shard, file), "utf8"),
            ) as BlobMeta;
            if (!prefix || meta.key.startsWith(prefix)) out.push(toMetadata(meta));
          } catch {
            continue;
          }
        }
      }
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}

/** HTTP 路由用：按 key 读出字节与类型（不存在返回 null）。 */
export function readBlobBytes(
  key: string,
): { bytes: Buffer; contentType: string } | null {
  const meta = readMeta(key);
  if (!meta) return null;
  try {
    const path = objectPath(key);
    if (!statSync(path).isFile()) return null;
    return { bytes: readFileSync(path), contentType: meta.contentType };
  } catch {
    return null;
  }
}
