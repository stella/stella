import { describe, expect, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-config";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

const { isOrgAIConfig, maskApiKey } =
  await import("@/api/lib/ai-config-crypto");
const { normalizeOrgAIConfig } = await import("@/api/lib/ai-config");

describe("maskApiKey", () => {
  // Rule: reveal min(8, floor(length / 4)) leading chars. A long, real key
  // exposes an 8-char identifying prefix; short/misconfigured keys never
  // expose more than a quarter of their length.
  test("reveals an 8-char prefix once the key is at least 32 chars", () => {
    // 35 chars: floor(35 / 4) = 8, so the whole 8-char cap is revealed.
    const masked = maskApiKey("sk-1234567890abcdefghijklmnopqrstuv");

    expect(masked).toBe(`sk-12345${"*".repeat(16)}`);
  });

  test("reveals only a quarter of a mid-length key, never half", () => {
    // A 16-char key exposes 4 chars (floor(16 / 4)); the old floor(length / 2)
    // rule would have leaked 8 — half the secret.
    expect(maskApiKey("0123456789abcdef")).toBe(`0123${"*".repeat(16)}`);
  });

  test("reveals a quarter of a short key", () => {
    // 8 chars -> floor(8 / 4) = 2 visible.
    expect(maskApiKey("abcd1234")).toBe(`ab${"*".repeat(16)}`);
  });

  test("reveals no chars for keys shorter than 4", () => {
    expect(maskApiKey("abc")).toBe("*".repeat(16));
    expect(maskApiKey("ab")).toBe("*".repeat(16));
    expect(maskApiKey("x")).toBe("*".repeat(16));
  });

  test("returns only asterisks for an empty string", () => {
    expect(maskApiKey("")).toBe("*".repeat(16));
  });

  test("caps visible chars at 8 for very long keys", () => {
    const masked = maskApiKey("a".repeat(200));

    expect(masked).toBe(`${"a".repeat(8)}${"*".repeat(16)}`);
  });
});

describe("isOrgAIConfig", () => {
  const fullOverrideModels = {
    chat: { provider: "openai", modelId: "gpt-5.4" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
  } satisfies OrgAIConfig["overrideModels"];

  test("accepts a valid org AI config", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "openai", apiKey: "sk-test" }],
        overrideModels: fullOverrideModels,
      }),
    ).toBe(true);
  });

  test("normalizes legacy Google regional configs to global", () => {
    expect(
      normalizeOrgAIConfig({
        providers: [{ provider: "google", apiKey: "sk-test", region: "eu" }],
        overrideModels: fullOverrideModels,
      }),
    ).toEqual({
      providers: [{ provider: "google", apiKey: "sk-test", region: "global" }],
      overrideModels: fullOverrideModels,
    });
  });

  test("accepts Azure Foundry org AI config with endpoint metadata", () => {
    expect(
      isOrgAIConfig({
        providers: [
          {
            provider: "azure_foundry",
            apiKey: "azure-test",
            baseURL: "https://example.openai.azure.com/openai",
            apiVersion: "2024-06-01",
          },
        ],
        overrideModels: {
          chat: { provider: "azure_foundry", modelId: "customer-chat" },
          fast: { provider: "azure_foundry", modelId: "customer-fast" },
          reasoning: {
            provider: "azure_foundry",
            modelId: "customer-reasoning",
          },
          pdf: { provider: "azure_foundry", modelId: "customer-pdf" },
        },
      }),
    ).toBe(true);
  });

  test("accepts Mistral org AI config", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "mistral", apiKey: "sk-test" }],
        overrideModels: {
          chat: { provider: "mistral", modelId: "mistral-large-latest" },
          fast: { provider: "mistral", modelId: "mistral-small-latest" },
          reasoning: {
            provider: "mistral",
            modelId: "magistral-medium-latest",
          },
          pdf: { provider: "mistral", modelId: "mistral-large-latest" },
        },
      }),
    ).toBe(true);
  });

  test("accepts Bedrock org AI config", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "bedrock", apiKey: "sk-test" }],
        overrideModels: {
          chat: { provider: "bedrock", modelId: "anthropic.claude-4-8-sonnet" },
          fast: { provider: "bedrock", modelId: "anthropic.claude-4-8-sonnet" },
          reasoning: {
            provider: "bedrock",
            modelId: "anthropic.claude-4-8-sonnet",
          },
          pdf: { provider: "bedrock", modelId: "anthropic.claude-4-8-sonnet" },
        },
      }),
    ).toBe(true);
  });

  test("accepts Hugging Face org AI config with endpoint metadata", () => {
    expect(
      isOrgAIConfig({
        providers: [
          {
            provider: "huggingface",
            apiKey: "hf-test",
            baseURL: "https://example.endpoints.huggingface.cloud/v1",
          },
        ],
        overrideModels: {
          chat: { provider: "huggingface", modelId: "customer-chat" },
          fast: { provider: "huggingface", modelId: "customer-fast" },
          reasoning: {
            provider: "huggingface",
            modelId: "customer-reasoning",
          },
          pdf: { provider: "huggingface", modelId: "customer-pdf" },
        },
      }),
    ).toBe(true);
  });

  test("rejects Azure Foundry configs without endpoint metadata", () => {
    expect(
      isOrgAIConfig({
        providers: [
          {
            provider: "azure_foundry",
            apiKey: "azure-test",
          },
        ],
        overrideModels: {
          chat: { provider: "azure_foundry", modelId: "customer-chat" },
          fast: { provider: "azure_foundry", modelId: "customer-fast" },
          reasoning: {
            provider: "azure_foundry",
            modelId: "customer-reasoning",
          },
          pdf: { provider: "azure_foundry", modelId: "customer-pdf" },
        },
      }),
    ).toBe(false);
  });

  test("rejects Hugging Face configs without endpoint metadata", () => {
    expect(
      isOrgAIConfig({
        providers: [
          {
            provider: "huggingface",
            apiKey: "hf-test",
          },
        ],
        overrideModels: {
          chat: { provider: "huggingface", modelId: "customer-chat" },
          fast: { provider: "huggingface", modelId: "customer-fast" },
          reasoning: {
            provider: "huggingface",
            modelId: "customer-reasoning",
          },
          pdf: { provider: "huggingface", modelId: "customer-pdf" },
        },
      }),
    ).toBe(false);
  });

  test("rejects configs missing any role in overrideModels", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "openai", apiKey: "sk-test" }],
        overrideModels: {
          chat: { provider: "openai", modelId: "gpt-5.4" },
        },
      }),
    ).toBe(false);
  });

  test("rejects unknown model override roles", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "openai", apiKey: "sk-test" }],
        overrideModels: {
          ...fullOverrideModels,
          unknown: { provider: "openai", modelId: "gpt-5.4" },
        },
      }),
    ).toBe(false);
  });

  test("rejects configs missing providers", () => {
    expect(
      isOrgAIConfig({
        overrideModels: fullOverrideModels,
      }),
    ).toBe(false);
  });

  test("rejects configs with model selections missing provider context", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "openai", apiKey: "sk-test" }],
        overrideModels: { ...fullOverrideModels, chat: "gpt-5.4" },
      }),
    ).toBe(false);
  });

  test("rejects OpenAI-compatible org BYOK configs", () => {
    expect(
      isOrgAIConfig({
        providers: [
          {
            provider: "openai_compatible",
            apiKey: "sk-test",
          },
        ],
        overrideModels: {
          chat: { provider: "openai_compatible", modelId: "default" },
          fast: { provider: "openai_compatible", modelId: "default" },
          reasoning: { provider: "openai_compatible", modelId: "default" },
          pdf: { provider: "openai_compatible", modelId: "default" },
        },
      }),
    ).toBe(false);
  });
});
