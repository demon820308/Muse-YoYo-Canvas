// File / blob domain of the privileged host handlers (split out of
// server/src/privileged.ts in batch S6 — a verbatim move, no behavior
// change): project working directories under
// ~/workspace/yoyo-canvas-projects, media file reads/writes inside
// them, and reads of this space's own blob store objects (the single
// root + layout rule lives in resolveBlobObjectPath below). The
// path/blob helpers here are shared by the media and package domains,
// which import them from this module.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isWindows, normalizePathForCompare } from "../platform";

const execFileAsync = promisify(execFile);

// [yoyo-local] 根目录改道：本地数据根由 local/server.ts 启动时注入
// YOYO_LOCAL_ROOT（缺省 <cwd>/data）。WORKSPACE_ROOT 取数据根的父目录
// （即应用目录），使原「路径必须在 ~/workspace 下」的守卫在本地等价
// 成立；PROJECTS_ROOT 落在数据根内的 yoyo-canvas-projects。
const DATA_ROOT = resolve(
  process.env.YOYO_LOCAL_ROOT ?? resolve(process.cwd(), "data"),
);
const WORKSPACE_ROOT = resolve(DATA_ROOT, "..");
const PROJECTS_ROOT = resolve(DATA_ROOT, "yoyo-canvas-projects");
const CUSTOM_DIRS_FILE = resolve(DATA_ROOT, "custom-project-dirs.json");

let customDirsCache: Set<string> | null = null;

function normalizeDirKey(dir: string): string {
  return normalizePathForCompare(resolve(dir));
}

function getCustomDirs(): Set<string> {
  if (customDirsCache) return customDirsCache;
  const set = new Set<string>();
  try {
    const raw = readFileSync(CUSTOM_DIRS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          set.add(normalizeDirKey(item));
        }
      }
    }
  } catch {
    // No custom dirs registered yet.
  }
  customDirsCache = set;
  return set;
}

async function registerCustomDir(dir: string): Promise<string> {
  const full = resolve(dir);
  const dirs = getCustomDirs();
  const key = normalizeDirKey(full);
  if (!dirs.has(key)) {
    dirs.add(key);
    await mkdir(DATA_ROOT, { recursive: true });
    const tmp = `${CUSTOM_DIRS_FILE}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tmp, JSON.stringify([...dirs], null, 2), "utf8");
      await rename(tmp, CUSTOM_DIRS_FILE);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
  return full;
}

function isUnderRoot(fullPath: string, root: string): boolean {
  const f = normalizePathForCompare(fullPath);
  const r = normalizePathForCompare(root);
  const rWithSep = r.endsWith(sep) ? r : r + sep;
  return f === r || f.startsWith(rWithSep);
}

function isAllowedProjectPath(fullPath: string): boolean {
  if (isUnderRoot(fullPath, PROJECTS_ROOT)) return true;
  for (const dir of getCustomDirs()) {
    if (isUnderRoot(fullPath, dir)) return true;
  }
  return false;
}

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

export const MAX_BYTES = 256 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

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

export function safeBase(name: string): string {
  return basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "-");
}

function projectDirPath(dirName: string, projectDir?: string): string {
  if (projectDir?.trim()) {
    const custom = resolve(projectDir.trim());
    if (isAllowedProjectPath(custom)) return custom;
  }
  const safe = safeBase(dirName);
  if (!safe || safe === "." || safe === "..") {
    throw new Error("invalid project dirName");
  }
  const full = resolve(PROJECTS_ROOT, safe);
  if (!full.startsWith(PROJECTS_ROOT + sep)) {
    throw new Error("project dir escapes yoyo-canvas-projects");
  }
  return full;
}

export function assertInProjectsRoot(path: string, what: string): string {
  const full = resolve(path);
  if (!isAllowedProjectPath(full)) {
    throw new Error(`${what} must be inside ~/workspace/yoyo-canvas-projects`);
  }
  return full;
}

/** Resolves one of this space's own blob objects to its single on-disk
 * location — the one place the store layout is defined, shared by every
 * blob read and mirror in this file. The store root has exactly one
 * deterministic source: the HATCH_SPACE_BLOB_DIR environment value when
 * the host process carries it, otherwise the canonical <spaceDir>/blobs.
 * The object file is objects/<sha256(key)[:2]>/<sha256(key)> — the only
 * layout. Nothing else is ever tried: a miss is an error naming the root
 * and object path that were actually attempted, never a cue to look
 * somewhere else. */
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

/** Reads one of this space's own blob objects' bytes from the location
 * resolveBlobObjectPath names. */
export async function readBlobObjectBytes(
  spaceDir: string,
  key: string,
  maxBytes = MAX_BYTES,
): Promise<Buffer> {
  const { root, objectPath } = resolveBlobObjectPath(spaceDir, key);
  let info;
  try {
    info = await stat(objectPath);
  } catch {
    throw new Error(
      `blob object not found for key "${key}" (root: ${root}, object: ${objectPath})`,
    );
  }
  if (!info.isFile() || info.size === 0) {
    throw new Error(
      `blob object not found for key "${key}" (root: ${root}, object: ${objectPath})`,
    );
  }
  if (info.size > maxBytes) {
    throw new Error(`blob exceeds ${Math.round(maxBytes / (1024 * 1024))}MB cap`);
  }
  return await readFile(objectPath);
}

async function copyDirFiles(srcDir: string, dstDir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = resolve(srcDir, entry.name);
    const dstPath = resolve(dstDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(dstPath, { recursive: true });
      count += await copyDirFiles(srcPath, dstPath);
    } else if (entry.isFile()) {
      await mkdir(dstDir, { recursive: true });
      await copyFile(srcPath, dstPath);
      count += 1;
    }
  }
  return count;
}

export const filesHandlers = {
  pickDirectory: async () => {
    if (!isWindows()) {
      return { path: null as string | null };
    }
    try {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$d.Description = '选择项目工作目录'",
        "$d.ShowNewFolderButton = $true",
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $d.SelectedPath }",
      ].join("; ");
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-Sta", "-Command", script],
        { timeout: 120_000 },
      );
      const picked = stdout.trim();
      return { path: picked || null };
    } catch {
      return { path: null as string | null };
    }
  },
  ensureProjectDir: async (args: { dirName: string; customDir?: string }) => {
    const custom = args.customDir?.trim();
    if (custom) {
      if (!isAbsolute(custom)) {
        throw new Error("ensureProjectDir: customDir must be an absolute path");
      }
      const full = await registerCustomDir(custom);
      await mkdir(full, { recursive: true });
      return { path: full };
    }
    const full = projectDirPath(args.dirName);
    await mkdir(full, { recursive: true });
    return { path: full };
  },
  moveProjectDir: async (args: {
    fromDir: string;
    toDir: string;
    extraDirs?: string[];
  }) => {
    const toRaw = args.toDir.trim();
    if (!isAbsolute(toRaw)) {
      throw new Error("moveProjectDir: 目标目录必须是绝对路径");
    }
    const to = resolve(toRaw);
    const candidateSources = [args.fromDir, ...(args.extraDirs ?? [])]
      .map((d) => resolve(d))
      .filter((d, idx, arr) => {
        const key = normalizeDirKey(d);
        if (key === normalizeDirKey(to)) return false;
        return arr.findIndex((x) => normalizeDirKey(x) === key) === idx;
      });
    for (const src of candidateSources) {
      if (isUnderRoot(to, src) || isUnderRoot(src, to)) {
        throw new Error("moveProjectDir: 目标目录不能是原目录的父目录或子目录");
      }
    }
    const registered = await registerCustomDir(to);
    await mkdir(registered, { recursive: true });
    let movedFiles = 0;
    const warnings: string[] = [];
    for (const src of candidateSources) {
      let srcExists = false;
      try {
        const info = await stat(src);
        srcExists = info.isDirectory();
      } catch {
        srcExists = false;
      }
      if (!srcExists) continue;
      movedFiles += await copyDirFiles(src, registered);
      try {
        await rm(src, { recursive: true, force: true });
      } catch (err) {
        warnings.push(
          err instanceof Error
            ? `旧目录清理未完全完成：${err.message}`
            : "旧目录部分文件被占用，未能完全清理",
        );
      }
    }
    return {
      path: registered,
      movedFiles,
      cleanupWarning: warnings.length > 0 ? warnings.join("；") : null,
    };
  },
  readMediaFile: async (args: { path: string }) => {
    const full = resolve(args.path);
    if (!isUnderRoot(full, WORKSPACE_ROOT) && !isAllowedProjectPath(full)) {
      throw new Error("readMediaFile: path must be under ~/workspace");
    }
    const ext = extname(full).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      throw new Error(`readMediaFile: unsupported extension ${ext}`);
    }
    const info = await stat(full);
    if (!info.isFile()) {
      throw new Error("readMediaFile: not a file");
    }
    if (info.size > MAX_BYTES) {
      throw new Error("readMediaFile: file exceeds 64MB cap");
    }
    const bytes = await readFile(full);
    return {
      dataBase64: bytes.toString("base64"),
      sizeBytes: bytes.byteLength,
      contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
    };
  },
  writeProjectFile: async (args: {
    dirName: string;
    projectDir?: string;
    fileName: string;
    dataBase64: string;
  }) => {
    const dir = projectDirPath(args.dirName, args.projectDir);
    const name = safeBase(args.fileName);
    if (!name || name === "." || name === "..") {
      throw new Error("writeProjectFile: invalid fileName");
    }
    const ext = extname(name).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      throw new Error(`writeProjectFile: unsupported extension ${ext}`);
    }
    const bytes = Buffer.from(args.dataBase64, "base64");
    if (bytes.byteLength > MAX_BYTES) {
      throw new Error("writeProjectFile: file exceeds 64MB cap");
    }
    await mkdir(dir, { recursive: true });
    const full = resolve(dir, name);
    await writeFile(full, bytes);
    return { path: full };
  },
  mirrorBlobToFile: async (args: {
    spaceDir: string;
    blobKey: string;
    dirName: string;
    projectDir?: string;
    fileName: string;
  }) => {
    const { root, objectPath } = resolveBlobObjectPath(args.spaceDir, args.blobKey);
    let info;
    try {
      info = await stat(objectPath);
    } catch {
      throw new Error(
        `mirrorBlobToFile: blob object not found for key "${args.blobKey}" (root: ${root}, object: ${objectPath})`,
      );
    }
    if (!info.isFile() || info.size === 0) {
      throw new Error(
        `mirrorBlobToFile: blob object not found for key "${args.blobKey}" (root: ${root}, object: ${objectPath})`,
      );
    }
    if (info.size > MAX_BYTES) {
      throw new Error(
        `mirrorBlobToFile: blob exceeds ${Math.round(MAX_BYTES / (1024 * 1024))}MB cap`,
      );
    }
    const dir = projectDirPath(args.dirName, args.projectDir);
    const name = safeBase(args.fileName);
    if (!name || name === "." || name === "..") {
      throw new Error("mirrorBlobToFile: invalid fileName");
    }
    const ext = extname(name).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      throw new Error(`mirrorBlobToFile: unsupported extension ${ext}`);
    }
    await mkdir(dir, { recursive: true });
    const full = resolve(dir, name);
    await copyFile(objectPath, full);
    return { path: full, sizeBytes: info.size };
  },
  importMediaFile: async (args: {
    fromPath: string;
    dirName: string;
    projectDir?: string;
    fileName: string;
  }) => {
    const from = resolve(args.fromPath);
    if (!from.startsWith(WORKSPACE_ROOT + sep)) {
      throw new Error("importMediaFile: source must be under ~/workspace");
    }
    const info = await stat(from);
    if (!info.isFile()) throw new Error("importMediaFile: source not a file");
    if (info.size > MAX_BYTES) {
      throw new Error("importMediaFile: source exceeds 64MB cap");
    }
    const dir = projectDirPath(args.dirName, args.projectDir);
    const name = safeBase(args.fileName);
    if (!name || name === "." || name === "..") {
      throw new Error("importMediaFile: invalid fileName");
    }
    const ext = extname(name).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      throw new Error(`importMediaFile: unsupported extension ${ext}`);
    }
    await mkdir(dir, { recursive: true });
    const full = resolve(dir, name);
    await copyFile(from, full);
    return { path: full, sizeBytes: info.size };
  },
};
