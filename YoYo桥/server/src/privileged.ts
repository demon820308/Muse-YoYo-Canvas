// Privileged host handlers for YoYo Bridge.
//
// Every bridge job gets one working directory under
// ~/workspace/yoyo-bridge-jobs (dirName = the job's directory name).
// All handlers validate that every path they touch resolves inside
// that root — an escaping path is refused, never followed. The
// implementations are ported from the YoYo画布 space's privileged
// handlers with only the root constant changed (project dirs →
// per-job dirs).
//
// Contracts:
//   ensureJobDir       — create a job's working directory.
//   writeJobFile       — write bytes (base64) into a job directory.
//   readJobFile        — read a file inside the jobs root as base64.
//   probeJobFile       — ffprobe a file inside the jobs root for its
//                        real pixel size / duration.
//   deleteJobFile      — delete one file in a job directory (missing
//                        file returns deleted:false, never throws).
//   deleteJobDir       — recursively delete a whole job directory.
//   mirrorBlobToJobFile — copy one of this space's own blob objects
//                        into a job directory.
//   convertImageToPng  — re-encode an image as PNG with ffmpeg.
//   shrinkImageForInference — downscaled copy for vision inference
//                        (long edge / byte caps).
// Action-reachable code imports only the descriptors from
// "@space/privileged"; the implementations here run on the host.

import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
copyFile,
mkdir,
readFile,
rm,
stat,
writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FFMPEG_BIN = "ffmpeg";
const FFPROBE_BIN = "ffprobe";

const JOBS_ROOT = resolve(homedir(), "workspace", "yoyo-bridge-jobs");
const MAX_BYTES = 256 * 1024 * 1024;

const ALLOWED_EXTS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp3",
  ".m4a",
  ".wav",
  ".aac",
  ".ogg",
]);

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

function safeBase(name: string): string {
  return basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "-");
}

function jobDirPath(dirName: string): string {
  const safe = safeBase(dirName);
  if (!safe || safe === "." || safe === "..") {
    throw new Error("invalid job dirName");
  }
  const full = resolve(JOBS_ROOT, safe);
  if (!full.startsWith(JOBS_ROOT + "/")) {
    throw new Error("job dir escapes yoyo-bridge-jobs");
  }
  return full;
}

function assertInJobsRoot(path: string, what: string): string {
  const full = resolve(path);
  if (!full.startsWith(JOBS_ROOT + "/")) {
    throw new Error(`${what} must be inside ~/workspace/yoyo-bridge-jobs`);
  }
  return full;
}

function jobFilePath(dirName: string, fileName: string): string {
  const dir = jobDirPath(dirName);
  const name = safeBase(fileName);
  if (!name || name === "." || name === "..") {
    throw new Error("invalid fileName");
  }
  const ext = extname(name).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`unsupported file extension ${ext}`);
  }
  return resolve(dir, name);
}

/** Resolves one of this space's own blob objects to its single
 * on-disk location (same rule as the canvas space): the store root
 * is the HATCH_SPACE_BLOB_DIR environment value when present,
 * otherwise <spaceDir>/blobs; the object file is
 * objects/<sha256(key)[:2]>/<sha256(key)>. */
function resolveBlobObjectPath(
  spaceDir: string,
  key: string,
): { root: string; objectPath: string } {
  const segments = key.split("/");
  if (
    key.startsWith("/") ||
    key.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error("invalid blob key");
  }
  const envRoot = process.env.HATCH_SPACE_BLOB_DIR?.trim();
  const root = envRoot ? resolve(envRoot) : resolve(spaceDir, "blobs");
  const objectId = createHash("sha256").update(key, "utf8").digest("hex");
  return {
    root,
    objectPath: resolve(root, "objects", objectId.slice(0, 2), objectId),
  };
}

async function probePixelSize(
  path: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        path,
      ],
      { timeout: 30_000 },
    );
    const parts = stdout.trim().split(",").map((v) => Number.parseInt(v, 10));
    const w = parts[0];
    const h = parts[1];
    if (
      w != null &&
      h != null &&
      Number.isFinite(w) &&
      Number.isFinite(h) &&
      w > 0 &&
      h > 0
    ) {
      return { width: w, height: h };
    }
    return null;
  } catch {
    return null;
  }
}

async function probeDurationSeconds(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { timeout: 30_000 },
    );
    const value = Number.parseFloat(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export const Contracts = definePrivilegedContracts({
  ensureJobDir: {
    description:
      "Creates (if needed) one bridge job's working directory under ~/workspace/yoyo-bridge-jobs and returns its absolute path.",
    request: z.object({ dirName: z.string().min(1).max(120) }),
    response: z.object({ path: z.string() }),
    capabilities: ["fs.write"],
  },
  writeJobFile: {
    description:
      "Writes bytes (base64) to a named file inside a bridge job's working directory under ~/workspace/yoyo-bridge-jobs and returns the absolute path.",
    request: z.object({
      dirName: z.string().min(1).max(120),
      fileName: z.string().min(1).max(200),
      dataBase64: z.string().min(1),
    }),
    response: z.object({ path: z.string() }),
    capabilities: ["fs.write"],
  },
  readJobFile: {
    description:
      "Reads a file inside ~/workspace/yoyo-bridge-jobs and returns its bytes as base64 with its byte size and content type.",
    request: z.object({ path: z.string().min(1) }),
    response: z.object({
      dataBase64: z.string(),
      sizeBytes: z.number(),
      contentType: z.string(),
    }),
    capabilities: ["fs.read"],
  },
  probeJobFile: {
    description:
      "Probes a media file inside ~/workspace/yoyo-bridge-jobs with ffprobe and returns its real pixel dimensions (null for audio) and duration in seconds (null when unknown).",
    request: z.object({ path: z.string().min(1) }),
    response: z.object({
      width: z.number().nullable(),
      height: z.number().nullable(),
      durationSeconds: z.number().nullable(),
    }),
    capabilities: ["fs.read", "process.exec"],
  },
  deleteJobFile: {
    description:
      "Deletes one named file inside a bridge job's working directory. A missing file returns deleted:false instead of throwing.",
    request: z.object({
      dirName: z.string().min(1).max(120),
      fileName: z.string().min(1).max(200),
    }),
    response: z.object({ deleted: z.boolean() }),
    capabilities: ["fs.write"],
  },
  deleteJobDir: {
    description:
      "Recursively deletes a whole bridge job working directory under ~/workspace/yoyo-bridge-jobs. A missing directory returns deleted:false instead of throwing.",
    request: z.object({ dirName: z.string().min(1).max(120) }),
    response: z.object({ deleted: z.boolean() }),
    capabilities: ["fs.write"],
  },
  mirrorBlobToJobFile: {
    description:
      "Copies one of this space's own blob objects into a bridge job's working directory and returns the absolute path and byte size.",
    request: z.object({
      spaceDir: z.string().min(1),
      blobKey: z.string().min(1).max(500),
      dirName: z.string().min(1).max(120),
      fileName: z.string().min(1).max(200),
    }),
    response: z.object({ path: z.string(), sizeBytes: z.number() }),
    capabilities: ["fs.read", "fs.write"],
  },
  convertImageToPng: {
    description:
      "Re-encodes an image file inside ~/workspace/yoyo-bridge-jobs as a PNG copy with ffmpeg. The source file is only read, never modified. Returns the produced absolute path.",
    request: z.object({
      input: z.string().min(1),
      outputDir: z.string().min(1),
      fileName: z.string().min(1).max(200),
    }),
    response: z.object({ path: z.string() }),
    capabilities: ["fs.read", "fs.write", "process.exec"],
  },
  shrinkImageForInference: {
    description:
      "Writes a downscaled copy of an image inside ~/workspace/yoyo-bridge-jobs for a size-capped consumer (vision inference): long edge at most maxEdge px and payload at most maxBytes, stepping the scale down until the payload fits. An image already within both caps is copied byte-for-byte. Returns the copy's path plus its measured dimensions.",
    request: z.object({
      input: z.string().min(1),
      outputDir: z.string().min(1),
      fileName: z.string().min(1).max(200),
      maxEdge: z.number().int().min(64).max(8192).optional(),
      maxBytes: z.number().int().min(1024).max(33554432).optional(),
    }),
    response: z.object({
      path: z.string(),
      width: z.number(),
      height: z.number(),
    }),
    capabilities: ["fs.read", "fs.write", "process.exec"],
  },
});

export const Handlers = definePrivilegedHandlers(Contracts, {
  ensureJobDir: async (args) => {
    const full = jobDirPath(args.dirName);
    await mkdir(full, { recursive: true });
    return { path: full };
  },
  writeJobFile: async (args) => {
    const full = jobFilePath(args.dirName, args.fileName);
    const bytes = Buffer.from(args.dataBase64, "base64");
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error("writeJobFile: file exceeds 256MB cap");
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return { path: full };
  },
  readJobFile: async (args) => {
    const full = assertInJobsRoot(args.path, "readJobFile path");
    const ext = extname(full).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      throw new Error(`readJobFile: unsupported extension ${ext}`);
    }
    const info = await stat(full);
    if (!info.isFile()) throw new Error("readJobFile: not a file");
    if (info.size > MAX_BYTES) {
      throw new Error("readJobFile: file exceeds 256MB cap");
    }
    const bytes = await readFile(full);
    return {
      dataBase64: bytes.toString("base64"),
      sizeBytes: bytes.byteLength,
      contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
    };
  },
  probeJobFile: async (args) => {
    const full = assertInJobsRoot(args.path, "probeJobFile path");
    const info = await stat(full);
    if (!info.isFile()) throw new Error("probeJobFile: not a file");
    const size = await probePixelSize(full);
    const durationSeconds = await probeDurationSeconds(full);
    return {
      width: size?.width ?? null,
      height: size?.height ?? null,
      durationSeconds,
    };
  },
  deleteJobFile: async (args) => {
    const full = jobFilePath(args.dirName, args.fileName);
    try {
      await rm(full);
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
  },
  deleteJobDir: async (args) => {
    const full = jobDirPath(args.dirName);
    try {
      const info = await stat(full);
      if (!info.isDirectory()) return { deleted: false };
    } catch {
      return { deleted: false };
    }
    await rm(full, { recursive: true, force: true });
    return { deleted: true };
  },
  mirrorBlobToJobFile: async (args) => {
    const { root, objectPath } = resolveBlobObjectPath(
      args.spaceDir,
      args.blobKey,
    );
    let info;
    try {
      info = await stat(objectPath);
    } catch {
      throw new Error(
        `mirrorBlobToJobFile: blob object not found for key "${args.blobKey}" (root: ${root}, object: ${objectPath})`,
      );
    }
    if (!info.isFile() || info.size === 0) {
      throw new Error(
        `mirrorBlobToJobFile: blob object not found for key "${args.blobKey}" (root: ${root}, object: ${objectPath})`,
      );
    }
    if (info.size > MAX_BYTES) {
      throw new Error("mirrorBlobToJobFile: blob exceeds 256MB cap");
    }
    const bytes = await readFile(objectPath);
    const full = jobFilePath(args.dirName, args.fileName);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return { path: full, sizeBytes: bytes.byteLength };
  },
  convertImageToPng: async (args) => {
    const input = assertInJobsRoot(args.input, "input");
    const info = await stat(input);
    if (!info.isFile()) throw new Error("convertImageToPng: input is not a file");
    const outDir = assertInJobsRoot(args.outputDir, "outputDir");
    await mkdir(outDir, { recursive: true });
    const name = safeBase(args.fileName);
    if (!name || extname(name).toLowerCase() !== ".png") {
      throw new Error("convertImageToPng: fileName must end in .png");
    }
    const out = resolve(outDir, name);
    if (dirname(out) !== outDir) {
      throw new Error("convertImageToPng: output escapes outputDir");
    }
    await execFileAsync(FFMPEG_BIN, ["-y", "-i", input, "-frames:v", "1", out], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const produced = await stat(out);
    if (!produced.isFile() || produced.size === 0) {
      throw new Error("convertImageToPng: ffmpeg produced no output");
    }
    return { path: out };
  },
  shrinkImageForInference: async (args) => {
    const input = assertInJobsRoot(args.input, "input");
    const info = await stat(input);
    if (!info.isFile()) {
      throw new Error("shrinkImageForInference: input is not a file");
    }
    const outDir = assertInJobsRoot(args.outputDir, "outputDir");
    await mkdir(outDir, { recursive: true });
    const name = safeBase(args.fileName);
    const ext = name ? extname(name).toLowerCase() : "";
    if (!name || (ext !== ".png" && ext !== ".jpg")) {
      throw new Error(
        "shrinkImageForInference: fileName must end in .png or .jpg",
      );
    }
    const out = resolve(outDir, name);
    if (dirname(out) !== outDir) {
      throw new Error("shrinkImageForInference: output escapes outputDir");
    }
    const maxEdge = args.maxEdge ?? 2048;
    const maxBytes = args.maxBytes ?? 3 * 1024 * 1024;
    const src = await probePixelSize(input);
    const srcW = src?.width ?? null;
    const srcH = src?.height ?? null;
    if (
      srcW != null &&
      srcH != null &&
      Math.max(srcW, srcH) <= maxEdge &&
      info.size <= maxBytes
    ) {
      await copyFile(input, out);
      return { path: out, width: srcW, height: srcH };
    }
    let edge = maxEdge;
    let lastW = srcW ?? 0;
    let lastH = srcH ?? 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const vf = `scale=w='min(iw,${edge})':h='min(ih,${edge})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`;
      const ffArgs =
        ext === ".jpg"
          ? ["-y", "-i", input, "-vf", vf, "-frames:v", "1", "-q:v", "3", out]
          : ["-y", "-i", input, "-vf", vf, "-frames:v", "1", out];
      await execFileAsync(FFMPEG_BIN, ffArgs, {
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const produced = await stat(out);
      if (!produced.isFile() || produced.size === 0) {
        throw new Error("shrinkImageForInference: ffmpeg produced no output");
      }
      const dims = await probePixelSize(out);
      lastW = dims?.width ?? lastW;
      lastH = dims?.height ?? lastH;
      if (produced.size <= maxBytes || edge <= 320) break;
      edge = Math.max(320, Math.floor(edge * 0.75));
    }
    return { path: out, width: lastW, height: lastH };
  },
});
