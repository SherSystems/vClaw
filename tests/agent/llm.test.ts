import { describe, it, expect, vi } from "vitest";

const defaultAnthropicCreate = vi.fn().mockResolvedValue({
  content: [{ type: "text", text: '{"result": "ok"}' }],
});

const defaultOpenAICreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: '{"result": "ok"}' } }],
});

vi.mock("@anthropic-ai/sdk", () => {
  const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
    this.messages = { create: defaultAnthropicCreate };
  });
  return { default: MockAnthropic };
});

vi.mock("openai", () => {
  const MockOpenAI = vi.fn(function (this: Record<string, unknown>) {
    this.chat = { completions: { create: defaultOpenAICreate } };
  });
  return { default: MockOpenAI };
});

import { callLLM, type AIConfig } from "../../src/agent/llm.js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const baseOptions = {
  system: "You are a test assistant.",
  user: "Do something.",
};

function makeConfig(provider: string): AIConfig {
  return {
    provider: provider as AIConfig["provider"],
    apiKey: "test-key",
    model: "test-model",
  };
}

describe("callLLM", () => {
  it("calls Anthropic SDK and returns text content", async () => {
    const result = await callLLM({
      ...baseOptions,
      config: makeConfig("anthropic"),
    });

    expect(result).toBe('{"result": "ok"}');
    expect(Anthropic).toHaveBeenCalledWith({ apiKey: "test-key" });
  });

  it("calls OpenAI SDK and returns message content", async () => {
    const result = await callLLM({
      ...baseOptions,
      config: makeConfig("openai"),
    });

    expect(result).toBe('{"result": "ok"}');
    expect(OpenAI).toHaveBeenCalledWith({ apiKey: "test-key" });
  });

  it("throws on unsupported provider", async () => {
    await expect(
      callLLM({ ...baseOptions, config: makeConfig("azure") }),
    ).rejects.toThrow("Unsupported AI provider");
  });

  it("strips markdown json fences from response", async () => {
    const AnthropicMock = vi.mocked(Anthropic);
    AnthropicMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '```json\n{"a":1}\n```' }],
        }),
      };
    } as unknown as () => Anthropic);

    const result = await callLLM({
      ...baseOptions,
      config: makeConfig("anthropic"),
    });

    expect(result).toBe('{"a":1}');
  });

  it("strips plain markdown fences from response", async () => {
    const AnthropicMock = vi.mocked(Anthropic);
    AnthropicMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '```\n{"a":1}\n```' }],
        }),
      };
    } as unknown as () => Anthropic);

    const result = await callLLM({
      ...baseOptions,
      config: makeConfig("anthropic"),
    });

    expect(result).toBe('{"a":1}');
  });

  it("returns trimmed text when no fences present", async () => {
    const AnthropicMock = vi.mocked(Anthropic);
    AnthropicMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '  {"plain": true}  ' }],
        }),
      };
    } as unknown as () => Anthropic);

    const result = await callLLM({
      ...baseOptions,
      config: makeConfig("anthropic"),
    });

    expect(result).toBe('{"plain": true}');
  });

  it("throws when Anthropic response has no text block", async () => {
    const AnthropicMock = vi.mocked(Anthropic);
    AnthropicMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "tool_use", id: "x", name: "t", input: {} }],
        }),
      };
    } as unknown as () => Anthropic);

    await expect(
      callLLM({ ...baseOptions, config: makeConfig("anthropic") }),
    ).rejects.toThrow("No text content");
  });

  it("throws when OpenAI response has no content", async () => {
    const OpenAIMock = vi.mocked(OpenAI);
    OpenAIMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.chat = {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: null } }],
          }),
        },
      };
    } as unknown as () => OpenAI);

    await expect(
      callLLM({ ...baseOptions, config: makeConfig("openai") }),
    ).rejects.toThrow("No content in OpenAI response");
  });

  it("uses default temperature 0 and maxTokens 4096", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });

    const AnthropicMock = vi.mocked(Anthropic);
    AnthropicMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.messages = { create: mockCreate };
    } as unknown as () => Anthropic);

    await callLLM({
      ...baseOptions,
      config: makeConfig("anthropic"),
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0,
        max_tokens: 4096,
      }),
    );
  });
});
