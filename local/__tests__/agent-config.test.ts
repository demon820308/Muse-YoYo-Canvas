import { describe, expect, test } from "bun:test";
import { maskKey, resolveModelsEndpoint } from "../agent";

describe("agent config helpers", () => {
  test("maskKey shows head and tail with asterisks in the middle", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("ab")).toBe("**");
    expect(maskKey("sk-1234")).toBe("s*****4");
    expect(maskKey("sk-1234567890abcd")).toBe("sk-1*********abcd");
    expect(maskKey("  sk-1234567890abcdef123456  ")).toBe("sk-1************3456");
  });

  test("resolveModelsEndpoint handles OpenAI and Anthropic base URLs", () => {
    expect(resolveModelsEndpoint("openai", "https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(resolveModelsEndpoint("openai", "https://api.example.com")).toBe(
      "https://api.example.com/v1/models",
    );
    expect(resolveModelsEndpoint("openai", "https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1/models",
    );
    expect(resolveModelsEndpoint("anthropic", "https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/models",
    );
    expect(resolveModelsEndpoint("anthropic", "https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });
});
