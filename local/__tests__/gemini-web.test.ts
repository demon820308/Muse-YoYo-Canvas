import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

process.env.YOYO_LOCAL_ROOT ??= mkdtempSync(resolve(tmpdir(), "yoyo-gweb-test-"));
process.env.HATCH_SPACE_BLOB_DIR ??= resolve(process.env.YOYO_LOCAL_ROOT, "blobs");

const {
  resolveBrowserBin,
  loadGeminiWebConfig,
  saveGeminiWebConfig,
  getGeminiWebStatus,
  handleGeminiWeb,
} = await import("../gemini-web");
const { handleAgy, getNodeEngine, saveAgyConfig } = await import("../agy");
const { dispatchImageGeneration } = await import(
  "../../server/src/actions/generation-dispatch"
);
const { GenerationActions } = await import("../../server/src/actions/generation");
const {
  GenerationRecordsActions,
  recordGenerationOutcome,
} = await import("../../server/src/actions/generation-records");
const { openDb } = await import("../db");
const schema = await import("../../server/src/schema");
const { resolveEffectiveAgyEngine } = await import("../../client/src/hooks/use-agy");

describe("local/gemini-web", () => {
  test("配置读写与未登录门控", async () => {
    saveGeminiWebConfig({ enabled: true });
    expect(loadGeminiWebConfig().enabled).toBe(true);
    const status = await getGeminiWebStatus(false);
    expect(status.loggedIn).toBe(false);
    expect(status.ready).toBe(false);

    saveAgyConfig({ enabled: false, model: "", nodeEngines: {} });
    const req = new Request("http://127.0.0.1/agy/node-engine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "n-gw-gate", engine: "gemini-web" }),
    });
    const res = await handleAgy(req, new URL(req.url));
    expect(res.status).toBe(400);
    expect(getNodeEngine("n-gw-gate")).toBe("muse");
  });

  test("POST /gemini-web/config 与未知路由处理", async () => {
    const req = new Request("http://127.0.0.1/gemini-web/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await handleGeminiWeb(req, new URL(req.url));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; config: { enabled: boolean } };
    expect(data.ok).toBe(true);
    expect(data.config.enabled).toBe(false);

    const notFound = await handleGeminiWeb(
      new Request("http://127.0.0.1/gemini-web/nope"),
      new URL("http://127.0.0.1/gemini-web/nope"),
    );
    expect(notFound.status).toBe(404);
  });

  test("resolveEffectiveAgyEngine 支持 gemini-web 与就绪门控", () => {
    expect(resolveEffectiveAgyEngine(false, {}, "img-1", "gemini-web", true)).toBe(
      "gemini-web",
    );
    expect(resolveEffectiveAgyEngine(false, {}, "img-1", "gemini-web", false)).toBe(
      "muse",
    );
    expect(
      resolveEffectiveAgyEngine(true, { "img-1": "gemini-web" }, "img-1", "agy", false),
    ).toBe("agy");
    expect(
      resolveEffectiveAgyEngine(false, { "img-1": "gemini-web" }, "img-1", "muse", true),
    ).toBe("gemini-web");
  });

  test("dispatchImageGeneration 分发到 localGeminiWeb 并支持未就绪报错", async () => {
    const { db } = openDb();
    const projectId = `proj-gweb-${crypto.randomUUID()}`;
    const ws = resolve(
      process.env.YOYO_LOCAL_ROOT!,
      "yoyo-canvas-projects",
      projectId,
    );
    mkdirSync(ws, { recursive: true });
    const now = new Date();
    await db.insert(schema.projects).values({
      id: projectId,
      name: "gweb-test",
      workspaceDir: ws,
      createdAt: now,
      updatedAt: now,
    });
    const imgId = `img-${crypto.randomUUID()}`;
    await db.insert(schema.canvasNodes).values({
      id: imgId,
      projectId,
      type: "image",
      title: "网页生图测试",
      prompt: "一只橘猫",
      genRatio: "16:9",
      createdAt: now,
      updatedAt: now,
    });
    const imgRow = (
      await db
        .select()
        .from(schema.canvasNodes)
        .where((await import("drizzle-orm")).eq(schema.canvasNodes.id, imgId))
    )[0]!;

    const failRes = await dispatchImageGeneration(
      {
        localGeminiWeb: {
          isReady: async () => false,
          startTask: () => "gweb-mock",
          cancelTask: () => {},
          generateImage: async () => ({ filePath: "" }),
        },
      } as never,
      db as never,
      imgRow,
      "gemini-web",
    );
    expect(failRes.status).toBe("failed");
    expect(failRes.error).toContain("Gemini 网页");

    let started = 0;
    let gwebRuns = 0;
    let agyRuns = 0;
    const okRes = await dispatchImageGeneration(
      {
        localAgy: {
          isReady: async () => true,
          getNodeEngine: (_id: string, def = "muse") => def,
          setNodeEngine: () => {},
          copyNodeEngine: () => {},
          startTask: () => {
            agyRuns += 1;
            started += 1;
            return `agy-task-${started}`;
          },
          cancelTask: () => {},
          generateImage: async () => ({ filePath: "" }),
          completeText: async () => ({ text: "" }),
        },
        localGeminiWeb: {
          isReady: async () => true,
          startTask: () => {
            gwebRuns += 1;
            started += 1;
            return `gweb-task-${started}`;
          },
          cancelTask: () => {},
          generateImage: async () => ({ filePath: "" }),
        },
      } as never,
      db as never,
      imgRow,
    );
    expect(okRes.status).toBe("working");
    expect(started).toBe(1);
    expect(gwebRuns).toBe(1);
    expect(agyRuns).toBe(0);
    expect(resolveBrowserBin("linux", {}) === null || typeof resolveBrowserBin("linux", {})?.path === "string").toBe(true);

    // 验证队列与生成记录返回 genEngine 来源标识
    const workingRow = (
      await db
        .select()
        .from(schema.canvasNodes)
        .where((await import("drizzle-orm")).eq(schema.canvasNodes.id, imgId))
    )[0]!;
    expect(workingRow.genTaskId?.startsWith("gweb-")).toBe(true);

    const reqRes = await GenerationActions.listGenerationRequests.handler(
      {
        db: () => db as never,
      } as never,
      {},
    );
    const queuedItem = reqRes.requests.find((r) => r.nodeId === imgId);
    expect(queuedItem?.genEngine).toBe("gemini-web");

    await recordGenerationOutcome(db as never, workingRow, {
      status: "done",
      resultNodeId: imgId,
      filePath: resolve(ws, "gw-test.png"),
      prompt: "一只橘猫",
    });
    const recRes = await GenerationRecordsActions.listGenerationRecords.handler(
      {
        db: () => db as never,
        blobs: { getUrl: async () => null },
      } as never,
      { projectId },
    );
    expect(recRes.records[0]?.genEngine).toBe("gemini-web");
  });

  test("历史共享 result.webp 参考图在分发前按节点独立 mediaBlobKey 自动还原隔离", async () => {
    const { db } = openDb();
    const { createCtx } = await import("../ctx");
    const { createBlobClient } = await import("../blobs");
    const realCtx = createCtx(db);
    const blobs = createBlobClient();
    const projectId = `p-${crypto.randomUUID().slice(0, 8)}`;
    const ws = resolve(
      process.env.YOYO_LOCAL_ROOT!,
      "yoyo-canvas-projects",
      projectId,
    );
    mkdirSync(ws, { recursive: true });
    const now = new Date();
    await db.insert(schema.projects).values({
      id: projectId,
      name: "iso-test",
      workspaceDir: ws,
      createdAt: now,
      updatedAt: now,
    });

    // 1x1 合法 PNG 字节，分别属于节点 A 与被覆盖的 shared result.webp
    const pngA = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    const blobKey = `media/${projectId}/${crypto.randomUUID()}`;
    await blobs.put(blobKey, pngA, { contentType: "image/png" });
    const sharedPath = resolve(ws, "result.webp");
    writeFileSync(sharedPath, Buffer.from("overwritten-by-node-b"));

    const refId = `ref-${crypto.randomUUID()}`;
    const targetId = `tgt-${crypto.randomUUID()}`;
    await db.insert(schema.canvasNodes).values([
      {
        id: refId,
        projectId,
        type: "image",
        title: "真实底图",
        mediaBlobKey: blobKey,
        mimeType: "image/png",
        filePath: sharedPath,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: targetId,
        projectId,
        type: "image",
        title: "下游生图",
        prompt: "画一张图",
        genRatio: "1:1",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.canvasEdges).values({
      id: `edge-${crypto.randomUUID()}`,
      projectId,
      fromNodeId: refId,
      toNodeId: targetId,
      createdAt: now,
    });

    let capturedRefPaths: string[] = [];
    const tgtRow = (
      await db
        .select()
        .from(schema.canvasNodes)
        .where((await import("drizzle-orm")).eq(schema.canvasNodes.id, targetId))
    )[0]!;

    const res = await dispatchImageGeneration(
      {
        ...realCtx,
        localAgy: {
          ...realCtx.localAgy!,
          isReady: async () => false,
        },
        localGeminiWeb: {
          isReady: async () => true,
          startTask: (runner: (o: { signal: AbortSignal }) => Promise<void>) => {
            void runner({ signal: new AbortController().signal });
            return "gweb-iso-1";
          },
          cancelTask: () => {},
          generateImage: async (opts: { refFilePaths: string[] }) => {
            capturedRefPaths = opts.refFilePaths;
            throw new Error("stop-after-capture");
          },
        },
      } as never,
      db as never,
      tgtRow,
      "gemini-web",
    );
    expect(res.status).toBe("working");
    await Bun.sleep(50);
    expect(capturedRefPaths.length).toBe(1);
    expect(basename(capturedRefPaths[0]!)).toBe(`${refId}.png`);
    expect(existsSync(capturedRefPaths[0]!)).toBe(true);
    expect(readFileSync(capturedRefPaths[0]!)).toEqual(pngA);
    // 验证无 filePath 的参考图与共用的自定义路径节点都会从 mediaBlobKey 自动同步隔离
    const blobB = `media/${projectId}/${crypto.randomUUID()}`;
    const pngB = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await blobs.put(blobB, pngB, { contentType: "image/png" });
    const sharedCustomPath = resolve(ws, "custom-shared.png");
    writeFileSync(sharedCustomPath, Buffer.from("stale-shared"));
    const refBId = `refb-${crypto.randomUUID()}`;
    const refDupSiblingId = `refd-${crypto.randomUUID()}`;
    const refMissingPathId = `refc-${crypto.randomUUID()}`;
    await db.insert(schema.canvasNodes).values([
      {
        id: refBId,
        projectId,
        type: "image",
        title: "共用路径图1",
        mediaBlobKey: blobB,
        mimeType: "image/png",
        filePath: sharedCustomPath,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: refDupSiblingId,
        projectId,
        type: "image",
        title: "共用路径图2",
        mediaBlobKey: blobB,
        mimeType: "image/png",
        filePath: sharedCustomPath,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: refMissingPathId,
        projectId,
        type: "image",
        title: "未落盘参考图",
        mediaBlobKey: blobKey,
        mimeType: "image/png",
        filePath: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.canvasEdges).values([
      {
        id: `edge-${crypto.randomUUID()}`,
        projectId,
        fromNodeId: refBId,
        toNodeId: targetId,
        createdAt: now,
      },
      {
        id: `edge-${crypto.randomUUID()}`,
        projectId,
        fromNodeId: refMissingPathId,
        toNodeId: targetId,
        createdAt: now,
      },
    ]);
    const { eq } = await import("drizzle-orm");

    const res2 = await dispatchImageGeneration(
      {
        ...realCtx,
        localAgy: {
          ...realCtx.localAgy!,
          isReady: async () => false,
        },
        localGeminiWeb: {
          isReady: async () => true,
          startTask: (runner: (o: { signal: AbortSignal }) => Promise<void>) => {
            void runner({ signal: new AbortController().signal });
            return "gweb-iso-2";
          },
          cancelTask: () => {},
          generateImage: async (opts: { refFilePaths: string[] }) => {
            capturedRefPaths = opts.refFilePaths;
            throw new Error("stop-after-capture");
          },
        },
      } as never,
      db as never,
      (await db.select().from(schema.canvasNodes).where(eq(schema.canvasNodes.id, targetId)))[0]!,
      "gemini-web",
    );
    expect(res2.status).toBe("working");
    await Bun.sleep(50);
    expect(capturedRefPaths.length).toBe(3);
    expect(capturedRefPaths.map((p) => basename(p))).toEqual([
      `${refId}.png`,
      `${refBId}.png`,
      `${refMissingPathId}.png`,
    ]);
    expect(readFileSync(capturedRefPaths[1]!)).toEqual(pngB);
  }, 15_000);
});
