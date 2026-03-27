// ============================================================
// vClaw — LLM Abstraction Layer
// Routes calls to Anthropic or OpenAI based on configuration
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface AIConfig {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
}

export interface CallLLMOptions {
  system: string;
  user: string;
  config: AIConfig;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Call an LLM provider and return the raw text response.
 * Uses temperature 0 for deterministic planning by default.
 * Strips markdown code fences from the response if present.
 */
export async function callLLM(options: CallLLMOptions): Promise<string> {
  const {
    system,
    user,
    config,
    temperature = 0,
    maxTokens = 4096,
  } = options;

  let raw: string;

  if (config.provider === "anthropic") {
    raw = await callAnthropic(system, user, config, temperature, maxTokens);
  } else if (config.provider === "openai") {
    raw = await callOpenAI(system, user, config, temperature, maxTokens);
  } else {
    throw new Error(`Unsupported AI provider: ${config.provider}`);
  }

  return stripMarkdownFences(raw);
}

async function callAnthropic(
  system: string,
  user: string,
  config: AIConfig,
  temperature: number,
  maxTokens: number,
): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Anthropic response");
  }

  return textBlock.text;
}

async function callOpenAI(
  system: string,
  user: string,
  config: AIConfig,
  temperature: number,
  maxTokens: number,
): Promise<string> {
  const client = new OpenAI({ apiKey: config.apiKey });

  const response = await client.chat.completions.create({
    model: config.model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No content in OpenAI response");
  }

  return content;
}

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) from LLM output.
 */
function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();

  // Match ```json\n...\n``` or ```\n...\n```
  const fencePattern = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const match = trimmed.match(fencePattern);
  if (match) {
    return match[1].trim();
  }

  return trimmed;
}
