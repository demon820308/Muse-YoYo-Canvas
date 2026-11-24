import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Isolate DATA_DIR before importing ../agent so other tests in the same bun test
// process never touch the real ./data directory.
process.env.YOYO_LOCAL_ROOT ??= mkdtempSync(resolve(tmpdir(), "yoyo-agent-test-"));

const { parseAgentJsonResponse, settleAgentBridgeTurn, matchEnabledSkills } = await import("../agent");

describe("local/agent parseAgentJsonResponse", () => {
  test("解析纯 JSON 与带 Markdown 代码块的 JSON", () => {
    const plain = parseAgentJsonResponse(
      '{"reply":"已创建","operations":[{"op":"create_node","type":"image","tempId":"n1"}]}',
    );
    expect(plain.reply).toBe("已创建");
    expect(plain.operations).toHaveLength(1);
    expect(plain.operations[0]?.op).toBe("create_node");

    const fenced = parseAgentJsonResponse(
      '好的：\n```json\n{"reply":"完成连线","operations":[{"op":"connect","source":"a","target":"b"}]}\n```',
    );
    expect(fenced.reply).toBe("完成连线");
    expect(fenced.operations).toHaveLength(1);
    expect(fenced.operations[0]?.op).toBe("connect");
  });

  test("非 JSON 文本优雅回退为纯文本回复", () => {
    const res = parseAgentJsonResponse("这是一段普通分析文本");
    expect(res.reply).toBe("这是一段普通分析文本");
    expect(res.operations).toEqual([]);
  });

  test("settleAgentBridgeTurn 对不存在的轮次安全无副作用", () => {
    expect(() =>
      settleAgentBridgeTurn("non-existent-turn", { ok: true, text: "{}" }),
    ).not.toThrow();
  });

  test("matchEnabledSkills 仅匹配已启用的 $slug 技能", () => {
    const skills = [
      {
        id: "1",
        slug: "storyboard-3cut",
        name: "三镜分镜",
        description: "",
        defaultPrompt: "",
        instructions: "rule",
        enabled: true,
        updatedAt: 1,
      },
      {
        id: "2",
        slug: "disabled-skill",
        name: "禁用技能",
        description: "",
        defaultPrompt: "",
        instructions: "rule2",
        enabled: false,
        updatedAt: 1,
      },
    ];
    expect(matchEnabledSkills(skills, "请用 $storyboard-3cut 生成").map((s) => s.slug)).toEqual([
      "storyboard-3cut",
    ]);
    expect(matchEnabledSkills(skills, "用 $disabled-skill")).toEqual([]);
  });
});
