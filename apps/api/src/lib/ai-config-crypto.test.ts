import { describe, expect, test } from "bun:test";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

const { isOrgAIConfig, maskApiKey } =
  await import("@/api/lib/ai-config-crypto");

describe("maskApiKey", () => {
  test("shows first 8 chars for keys longer than 16 chars", () => {
    const masked = maskApiKey("sk-1234567890abcdefghij");

    expect(masked).toBe(`sk-12345${"*".repeat(16)}`);
  });

  test("shows half the key when length is between 2 and 16", () => {
    expect(maskApiKey("abcd1234")).toBe(`abcd${"*".repeat(16)}`);
  });

  test("shows 1 visible char for a 2-char key", () => {
    expect(maskApiKey("ab")).toBe(`a${"*".repeat(16)}`);
  });

  test("shows 0 visible chars for a 1-char key", () => {
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
  };

  test("accepts a valid org AI config", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "openai", apiKey: "sk-test" }],
        overrideModels: fullOverrideModels,
      }),
    ).toBe(true);
  });

  test("accepts Azure Foundry org AI config with endpoint metadata", () => {
    expect(
      isOrgAIConfig({
        providers: [
          {
            provider: "azure_foundry",
            apiKey: "azure-test",
            baseURL: "https://example.openai.azure.com/openai",
            apiVersion: "v1",
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
