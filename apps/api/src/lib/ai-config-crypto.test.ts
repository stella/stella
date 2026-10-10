import { describe, expect, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

const { decryptAIConfig, encryptAIConfig, isOrgAIConfig, maskApiKey } =
  await import("@/api/lib/ai-config-crypto");
const { encryptContent } = await import("@/api/lib/content-encryption");
const { normalizeOrgAIConfig } = await import("@/api/lib/ai-config");

describe("maskApiKey", () => {
  test("retains only provider prefix and last four", () => {
    expect(maskApiKey("sk-or-v1-1234567890abcdefghijklmnop1234")).toBe(
      "sk-or-v1-****1234",
    );
    expect(maskApiKey("sk-ant-usr-1234567890abcdefghijklmnop5678")).toBe(
      "sk-ant-usr-****5678",
    );
    expect(maskApiKey("0123456789abcdef")).toBe("****cdef");
  });
  test("short credentials reveal nothing", () => {
    for (const key of [
      "",
      "x",
      "abcd1234",
      "sk-ant-api03-1234",
      "sk-or-v1-abcd1234",
    ]) {
      expect(maskApiKey(key)).toBe("****");
    }
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
        decision: null,
      }),
    ).toEqual({
      providers: [{ provider: "google", apiKey: "sk-test", region: "global" }],
      overrideModels: fullOverrideModels,
      decision: null,
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

  test("accepts sparse custom model overrides", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "openai", apiKey: "sk-test" }],
        overrideModels: {
          chat: { provider: "openai", modelId: "gpt-5.4" },
        },
      }),
    ).toBe(true);
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

  test("rejects a decision model on an unknown provider", () => {
    expect(
      isOrgAIConfig({
        providers: [{ provider: "openai", apiKey: "sk-test" }],
        overrideModels: fullOverrideModels,
        decision: {
          provider: "some-other-vendor",
          apiKey: "ts-test",
          modelId: "model-1",
        },
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

describe("decision model in the stored blob", () => {
  const organizationId = toSafeId<"organization">("org_decision_crypto_test");
  const providers = [
    { provider: "openai", apiKey: "sk-test" },
  ] satisfies OrgAIConfig["providers"];
  const overrideModels = {
    chat: { provider: "openai", modelId: "gpt-5.4" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
  } satisfies OrgAIConfig["overrideModels"];

  test("reads a blob written before the decision model existed as none", async () => {
    const { ciphertext, iv } = await encryptContent(
      organizationId,
      JSON.stringify({ providers, overrideModels }),
    );

    const config = await decryptAIConfig(organizationId, ciphertext, iv);

    expect(config.decision).toBeNull();
  });

  test("round-trips a configured decision model", async () => {
    const decision = {
      provider: "typesafe",
      apiKey: "ts-secret-key",
      modelId: "jev-1.13",
    } as const;

    const { ciphertext, iv } = await encryptAIConfig(organizationId, {
      providers,
      overrideModels,
      decision,
    });
    const config = await decryptAIConfig(organizationId, ciphertext, iv);

    expect(config.decision).toEqual(decision);
  });
  test("round-trips an Anthropic workspace id alongside its key", async () => {
    const anthropicProviders = [
      {
        provider: "anthropic",
        apiKey: "sk-ant-usr-fixture",
        anthropicWorkspaceId: "wrk_fixture",
      },
    ] satisfies OrgAIConfig["providers"];
    const { ciphertext, iv } = await encryptAIConfig(organizationId, {
      providers: anthropicProviders,
      overrideModels,
      decision: null,
    });
    const config = await decryptAIConfig(organizationId, ciphertext, iv);
    expect(config.providers).toEqual([
      {
        provider: "anthropic",
        apiKey: "sk-ant-usr-fixture",
        anthropicWorkspaceId: "wrk_fixture",
        region: "global",
      },
    ]);
    expect(
      isOrgAIConfig({
        providers: [
          {
            provider: "openai",
            apiKey: "sk-fixture",
            anthropicWorkspaceId: "wrk_fixture",
          },
        ],
        overrideModels,
        decision: null,
      }),
    ).toBe(false);
  });
});

test("encrypted configuration schema accepts catalog defaults without custom overrides", () => {
  expect(
    isOrgAIConfig({
      providers: [{ provider: "openai", apiKey: "fixture-key" }],
      overrideModels: null,
      decision: null,
    }),
  ).toBe(true);
});
