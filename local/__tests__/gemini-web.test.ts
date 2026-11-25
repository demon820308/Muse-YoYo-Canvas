import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

process.env.YOYO_LOCAL_ROOT ??= mkdtempSync(resolve(tmpdir(), "yoyo-gweb-test-"));

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
});
