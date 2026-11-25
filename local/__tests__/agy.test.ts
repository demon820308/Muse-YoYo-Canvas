import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.YOYO_LOCAL_ROOT ??= mkdtempSync(resolve(tmpdir(), "yoyo-agy-test-"));

const {
  parseAgyModelsOutput,
  pickDefaultAgyModel,
  mapAspectRatioForAgy,
  ensureAgyTrustedWorkspaces,
  loadAgyConfig,
  saveAgyConfig,
  getNodeEngine,
  setNodeEngine,
  copyNodeEngine,
  handleAgy,
} = await import("../agy");
const { dispatchImageGeneration, dispatchConfigGeneration } = await import(
  "../../server/src/actions/generation-dispatch"
);
const { runToolDispatch } = await import("../../server/src/actions/tool-dispatch");
const { openDb } = await import("../db");
const schema = await import("../../server/src/schema");

const { formatAgyModelShortName, resolveEffectiveAgyEngine } = await import(
  "../../client/src/hooks/use-agy"
);

describe("local/agy helpers", () => {
  test("formatAgyModelShortName 去掉尾部推理档位并保留模型短名", () => {
    const models = [
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)" },
    ];
    expect(formatAgyModelShortName("gemini-3.8-flash-medium", models)).toBe(
      "Gemini 3.8 Flash",
    );
    expect(formatAgyModelShortName("gemini-4-carbon-high", models)).toBe(
      "Gemini 4 Carbon",
    );
    expect(
      formatAgyModelShortName("unknown-id", [], "Claude Sonnet 5.5 (Low)"),
    ).toBe("Claude Sonnet 5.5");
  });

  test("parseAgyModelsOutput 解析模型列表并去重", () => {
    const raw = [
      "Fetching available models...",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "claude-sonnet-5-5-medium  Claude Sonnet 5.5 (Medium)",
    ].join("\n");
    expect(parseAgyModelsOutput(raw)).toEqual([
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)" },
      { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
    ]);
  });

  test("pickDefaultAgyModel 优先选推荐默认模型", () => {
    expect(
      pickDefaultAgyModel([
        { id: "gpt-oss-120b-medium", label: "GPT-OSS" },
        { id: "gemini-3.8-flash-medium", label: "Flash" },
      ]),
    ).toBe("gemini-3.8-flash-medium");
    expect(
      pickDefaultAgyModel([{ id: "custom-model", label: "Custom" }]),
    ).toBe("custom-model");
  });

  test("mapAspectRatioForAgy 将 21:9 归入 16:9，其余七档原样透传", () => {
    for (const r of ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"]) {
      expect(mapAspectRatioForAgy(r)).toBe(r);
    }
    expect(mapAspectRatioForAgy("21:9")).toBe("16:9");
    expect(mapAspectRatioForAgy(null)).toBe("16:9");
  });

  test("ensureAgyTrustedWorkspaces 合并 trustedWorkspaces 且保留既有配置", () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), "yoyo-agy-home-"));
    const cliDir = join(fakeHome, ".gemini", "antigravity-cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliDir, "settings.json"),
      JSON.stringify({ colorScheme: "dark", trustedWorkspaces: ["C:\\Existing"] }),
      "utf8",
    );
    const dirA = resolve(fakeHome, "data");
    ensureAgyTrustedWorkspaces([dirA, dirA], fakeHome);
    const saved = JSON.parse(readFileSync(join(cliDir, "settings.json"), "utf8"));
    expect(saved.colorScheme).toBe("dark");
    expect(saved.trustedWorkspaces).toEqual(["C:\\Existing", dirA]);
    expect(existsSync(join(cliDir, "settings.json"))).toBe(true);
  });

  test("nodeEngines 默认回退到传入默认值，支持按节点切换与派生复制", () => {
    saveAgyConfig({ enabled: false, model: "", nodeEngines: {} });
    expect(getNodeEngine("n-1")).toBe("muse");
    expect(getNodeEngine("n-1", "agy")).toBe("agy");
    setNodeEngine("n-1", "agy");
    expect(getNodeEngine("n-1")).toBe("agy");
    copyNodeEngine("n-1", "n-2");
    expect(getNodeEngine("n-2")).toBe("agy");
    setNodeEngine("n-1", "muse");
    expect(getNodeEngine("n-1", "agy")).toBe("muse");
    expect(loadAgyConfig().nodeEngines["n-1"]).toBe("muse");
    copyNodeEngine("n-1", "n-3");
    expect(getNodeEngine("n-3", "agy")).toBe("muse");
  });

  test("resolveEffectiveAgyEngine 在 AGY 就绪时让图片节点默认走 agy，且可手动切回 muse", () => {
    expect(resolveEffectiveAgyEngine(false, {}, "img-1", "agy")).toBe("muse");
    expect(resolveEffectiveAgyEngine(true, {}, "img-1", "agy")).toBe("agy");
    expect(resolveEffectiveAgyEngine(true, { "img-1": "muse" }, "img-1", "agy")).toBe("muse");
    expect(resolveEffectiveAgyEngine(true, {}, "cfg-1", "muse")).toBe("muse");
    expect(resolveEffectiveAgyEngine(true, { "cfg-1": "agy" }, "cfg-1", "muse")).toBe("agy");
  });

  test("AGY 未就绪时 POST /agy/node-engine 拒绝切换为 agy", async () => {
    saveAgyConfig({ enabled: false, model: "", nodeEngines: {} });
    const req = new Request("http://127.0.0.1/agy/node-engine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "n-gate", engine: "agy" }),
    });
    const res = await handleAgy(req, new URL(req.url));
    expect(res.status).toBe(400);
    expect(getNodeEngine("n-gate")).toBe("muse");
  });
});

describe("AGY 生成分发与门控", () => {
  test("未就绪时走 agy 引擎会明确失败；默认 muse 照常分发", async () => {
    const { db } = openDb();
    const projectId = `proj-agy-${crypto.randomUUID()}`;
    const ws = resolve(process.env.YOYO_LOCAL_ROOT!, "yoyo-canvas-projects", projectId);
    mkdirSync(ws, { recursive: true });
    const now = new Date();
    await db.insert(schema.projects).values({
      id: projectId,
      name: "agy-test",
      workspaceDir: ws,
      createdAt: now,
      updatedAt: now,
    });
    const imgId = `img-${crypto.randomUUID()}`;
    const cfgId = `cfg-${crypto.randomUUID()}`;
    await db.insert(schema.canvasNodes).values([
      {
        id: imgId,
        projectId,
        type: "image",
        title: "测试图",
        prompt: "一只橘猫",
        genRatio: "16:9",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cfgId,
        projectId,
        type: "config",
        title: "测试配置",
        prompt: "写一段脚本",
        genMode: "text",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const fakeCtxNotReady = {
      localAgy: {
        isReady: async () => false,
        getNodeEngine: () => "muse" as const,
        setNodeEngine: () => {},
        copyNodeEngine: () => {},
        startTask: () => "agy-mock",
        cancelTask: () => {},
        generateImage: async () => ({ filePath: "" }),
        completeText: async () => ({ text: "" }),
      },
    } as never;

    const imgRow = (
      await db.select().from(schema.canvasNodes).where((await import("drizzle-orm")).eq(schema.canvasNodes.id, imgId))
    )[0]!;
    const cfgRow = (
      await db.select().from(schema.canvasNodes).where((await import("drizzle-orm")).eq(schema.canvasNodes.id, cfgId))
    )[0]!;

    const failImg = await dispatchImageGeneration(fakeCtxNotReady, db as never, imgRow, "agy");
    expect(failImg.status).toBe("failed");
    expect(failImg.error).toContain("AGY CLI");

    const failCfg = await dispatchConfigGeneration(fakeCtxNotReady, db as never, cfgRow, "agy");
    expect(failCfg.status).toBe("failed");
    expect(failCfg.error).toContain("AGY CLI");

    let started = 0;
    const fakeCtxReady = {
      localAgy: {
        isReady: async () => true,
        getNodeEngine: () => "muse" as const,
        setNodeEngine: () => {},
        copyNodeEngine: () => {},
        startTask: () => {
          started += 1;
          return `agy-task-${started}`;
        },
        cancelTask: () => {},
        generateImage: async () => ({ filePath: "" }),
        completeText: async () => ({ text: "ok" }),
      },
    } as never;

    const okImg = await dispatchImageGeneration(fakeCtxReady, db as never, imgRow, "agy");
    expect(okImg.status).toBe("working");
    const okCfg = await dispatchConfigGeneration(fakeCtxReady, db as never, cfgRow, "agy");
    expect(okCfg.status).toBe("working");
    expect(started).toBe(2);

    saveAgyConfig({ enabled: true, model: "gemini-3.8-flash-medium", nodeEngines: {} });
    const autoDefaultImg = await dispatchImageGeneration(
      {
        localAgy: {
          isReady: async () => true,
          getNodeEngine,
          setNodeEngine,
          copyNodeEngine,
          startTask: () => {
            started += 1;
            return `agy-task-${started}`;
          },
          cancelTask: () => {},
          generateImage: async () => ({ filePath: "" }),
          completeText: async () => ({ text: "ok" }),
        },
      } as never,
      db as never,
      imgRow,
    );
    expect(autoDefaultImg.status).toBe("working");
    expect(started).toBe(3);
    expect(typeof runToolDispatch).toBe("function");
  });
});
