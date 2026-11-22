import { describe, expect, test } from "bun:test";
import { buildVideoRelayPrompt } from "../tool-dispatch";

describe("buildVideoRelayPrompt", () => {
  test("留空提示词时生成不重复前段动作的默认续接提示词", () => {
    const out = buildVideoRelayPrompt("   ", "前段已完成托马斯转身");
    expect(out).toContain("原视频尾帧");
    expect(out).not.toContain("托马斯转身");
  });

  test("填写新视频提示词时以新提示词为准且不混入前段动作", () => {
    const out = buildVideoRelayPrompt("少女微笑挥手告别", "前段已完成托马斯转身");
    expect(out).toContain("少女微笑挥手告别");
    expect(out).not.toContain("托马斯转身");
  });
});
