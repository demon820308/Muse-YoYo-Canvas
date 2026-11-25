import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../../schema";
import type { Db } from "../contracts";
import {
  buildGenerationContext,
  resolveMaskGenerationContext,
} from "../generation-context";

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
  return drizzle(client, { schema }) as unknown as Db;
}

describe("resolveMaskGenerationContext", () => {
  test("未绘制蒙版节点连入下游生图时给出明确提示", async () => {
    const db = await makeDb();
    const now = new Date();
    await db.insert(schema.projects).values({
      id: "p1",
      name: "mask-test",
      workspaceDir: "/tmp/p1",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.canvasNodes).values([
      {
        id: "img-base",
        projectId: "p1",
        type: "image",
        title: "原图",
        mediaBlobKey: "media/p1/img-base",
        filePath: "/tmp/p1/base.png",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "mask-empty",
        projectId: "p1",
        type: "image-mask",
        title: "蒙版",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "gen-node",
        projectId: "p1",
        type: "image",
        title: "结果图",
        prompt: "",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.canvasEdges).values([
      { id: "e1", projectId: "p1", fromNodeId: "img-base", toNodeId: "mask-empty" },
      { id: "e2", projectId: "p1", fromNodeId: "mask-empty", toNodeId: "gen-node" },
    ]);

    const [genRow] = await db.select().from(schema.canvasNodes).where((await import("drizzle-orm")).eq(schema.canvasNodes.id, "gen-node"));
    const rawCtx = await buildGenerationContext(db, genRow!, "");
    const resolved = await resolveMaskGenerationContext(db, genRow!, rawCtx, "remove");
    expect(resolved.maskError).toContain("尚未绘制蒙版");
  });

  test("原图->蒙版->生图（+参考图）不重复附带原图并按 [蒙版, 参考图] 排序封装提示词", async () => {
    const db = await makeDb();
    const now = new Date();
    await db.insert(schema.projects).values({
      id: "p1",
      name: "mask-test",
      workspaceDir: "/tmp/p1",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.canvasNodes).values([
      {
        id: "img-base",
        projectId: "p1",
        type: "image",
        title: "原图",
        mediaBlobKey: "media/p1/img-base",
        filePath: "/tmp/p1/base.png",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "mask-1",
        projectId: "p1",
        type: "image-mask",
        title: "蒙版",
        prompt: JSON.stringify({ colorKey: "red", opacity: 60, inverted: false, fillHoles: true, outputMode: "color" }),
        mediaBlobKey: "media/p1/mask-1",
        filePath: "/tmp/p1/mask.png",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "img-outfit",
        projectId: "p1",
        type: "image",
        title: "西装参考",
        mediaBlobKey: "media/p1/img-outfit",
        filePath: "/tmp/p1/outfit.png",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "gen-node",
        projectId: "p1",
        type: "image",
        title: "换装结果",
        prompt: "",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.canvasEdges).values([
      { id: "e1", projectId: "p1", fromNodeId: "img-base", toNodeId: "mask-1", sortOrder: 0 },
      { id: "e2", projectId: "p1", fromNodeId: "img-outfit", toNodeId: "gen-node", sortOrder: 0 },
      { id: "e3", projectId: "p1", fromNodeId: "mask-1", toNodeId: "gen-node", sortOrder: 1 },
    ]);

    const [genRow] = await db.select().from(schema.canvasNodes).where((await import("drizzle-orm")).eq(schema.canvasNodes.id, "gen-node"));
    const rawCtx = await buildGenerationContext(db, genRow!, "");
    const resolved = await resolveMaskGenerationContext(db, genRow!, rawCtx, "outfit");

    expect(resolved.maskError).toBeNull();
    expect(resolved.context.imageRefs.map((r) => r.nodeId)).toEqual([
      "mask-1",
      "img-outfit",
    ]);
    expect(resolved.context.prompt).not.toContain("图1为原始底图");
    expect(resolved.context.prompt).toContain("图1是用半透明红色高亮标出需要修改区域的底图");
    expect(resolved.context.prompt).toContain("仅提取并迁移图2中的服装/配饰款式");

    const removeResolved = await resolveMaskGenerationContext(db, genRow!, rawCtx, "remove");
    expect(removeResolved.context.prompt).toContain("彻底移除");

    // 换脸模式与 @ 引用编号重映射校验
    const faceChipCtx = await buildGenerationContext(db, genRow!, "把脸换成 @[node:img-outfit]");
    const faceResolved = await resolveMaskGenerationContext(
      db,
      { ...genRow!, prompt: "把脸换成 @[node:img-outfit]" },
      faceChipCtx,
      "face",
    );
    expect(faceResolved.context.prompt).toContain("替换为图2中人物的五官长相");
    expect(faceResolved.context.prompt).toContain("把脸换成 图2");
    expect(faceResolved.context.prompt).not.toContain("图片1");
  });

  test("[原图, 参考图]->蒙版->生图（参考图连在蒙版上且未手选模式/未写词）不带原图、保留蒙版与参考图并自动走参考替换而非移除", async () => {
    const db = await makeDb();
    const now = new Date();
    await db.insert(schema.projects).values({
      id: "p2",
      name: "mask-upstream-ref",
      workspaceDir: "/tmp/p2",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.canvasNodes).values([
      {
        id: "img-base",
        projectId: "p2",
        type: "image",
        title: "原图",
        mediaBlobKey: "media/p2/img-base",
        filePath: "/tmp/p2/base.png",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "img-face",
        projectId: "p2",
        type: "image",
        title: "参考脸",
        mediaBlobKey: "media/p2/img-face",
        filePath: "/tmp/p2/face.png",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "mask-1",
        projectId: "p2",
        type: "image-mask",
        title: "绘制蒙版",
        prompt: JSON.stringify({ outputMode: "original", brushColor: "green" }),
        mediaBlobKey: "media/p2/mask-1",
        filePath: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "gen-node",
        projectId: "p2",
        type: "image",
        title: "生图",
        prompt: "",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.canvasEdges).values([
      { id: "e1", projectId: "p2", fromNodeId: "img-base", toNodeId: "mask-1", sortOrder: 0 },
      { id: "e2", projectId: "p2", fromNodeId: "img-face", toNodeId: "mask-1", sortOrder: 1 },
      { id: "e3", projectId: "p2", fromNodeId: "mask-1", toNodeId: "gen-node", sortOrder: 0 },
    ]);

    const [genRow] = await db.select().from(schema.canvasNodes).where((await import("drizzle-orm")).eq(schema.canvasNodes.id, "gen-node"));
    const rawCtx = await buildGenerationContext(db, genRow!, "");
    const resolved = await resolveMaskGenerationContext(db, genRow!, rawCtx, undefined);

    expect(resolved.maskError).toBeNull();
    expect(resolved.context.imageRefs.map((r) => r.nodeId)).toEqual([
      "mask-1",
      "img-face",
    ]);
    expect(resolved.context.prompt).toContain("图2为目标参考图");
    expect(resolved.context.prompt).toContain("自然替换并融合为图2中对应主体/部位的外观与特征");
    expect(resolved.context.prompt).not.toContain("彻底移除");

    // 无参考图且无提示词、未指定模式时，默认走移除模式
    await db.delete(schema.canvasEdges).where((await import("drizzle-orm")).eq(schema.canvasEdges.id, "e2"));
    const plainCtx = await buildGenerationContext(db, genRow!, "");
    const plainResolved = await resolveMaskGenerationContext(db, genRow!, plainCtx, undefined);
    expect(plainResolved.context.prompt).toContain("彻底移除");
  });
});
