import { describe, expect, test } from "bun:test";

import { BYOK_MODEL_OPTIONS, TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { BYOKProvider } from "@stll/ai-catalog";

import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";
process.env["AI_PROVIDER"] = "openai";
process.env["OPENAI_API_KEY"] ??= "test-openai-instance-key";

env.AI_PROVIDER = "openai";
env.OPENAI_API_KEY = "test-openai-instance-key";

const {
  decodeChatModelSelection,
  encodeChatModelSelection,
  getChatModelReasoningEfforts,
  getConfiguredChatModelOptions,
  getDefaultChatModelValue,
  isChatModelReasoningEffortAvailable,
  isChatModelSelectionAvailable,
  resolveEffectiveChatModelId,
  resolveEffectiveChatModelSelection,
} = await import("@/api/lib/chat-model-selection");

const orgConfigForProviders = (providers: BYOKProvider[]): OrgAIConfig => ({
  providers: providers.map((provider) => ({
    provider,
    apiKey: "test-org-provider-key",
  })),
  overrideModels: {
    fast: { provider: providers[0] ?? "anthropic", modelId: "fast-default" },
    chat: {
      provider: providers[0] ?? "anthropic",
      modelId: BYOK_MODEL_OPTIONS[providers[0] ?? "anthropic"][0],
    },
    reasoning: {
      provider: providers[0] ?? "anthropic",
      modelId: "reasoning-default",
    },
    pdf: { provider: providers[0] ?? "anthropic", modelId: "pdf-default" },
  },
});

describe("encodeChatModelSelection / decodeChatModelSelection", () => {
  test("round-trips every catalog provider/model pair", () => {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        const encoded = encodeChatModelSelection({ provider, modelId });
        expect(decodeChatModelSelection(encoded)).toEqual({
          provider,
          modelId,
        });
      }
    }
  });

  test("round-trips a bedrock model id containing single colons", () => {
    const selection = {
      provider: "bedrock" as const,
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    };
    expect(
      decodeChatModelSelection(encodeChatModelSelection(selection)),
    ).toEqual(selection);
  });

  test.each([
    "",
    "anthropic",
    "anthropic::",
    "::model-id",
    "not-a-provider::model-id",
    "azure_foundry::gpt-5.4",
    "constructor::model-id",
    "toString::model-id",
  ])("rejects malformed input: %s", (value) => {
    expect(decodeChatModelSelection(value)).toBeNull();
  });
});

describe("isChatModelSelectionAvailable", () => {
  test("accepts a catalog model whose provider is configured for the org", () => {
    const orgAIConfig = orgConfigForProviders(["anthropic"]);
    expect(
      isChatModelSelectionAvailable({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        orgAIConfig,
      }),
    ).toBe(true);
  });

  test("rejects a model id not offered by the catalog", () => {
    const orgAIConfig = orgConfigForProviders(["anthropic"]);
    expect(
      isChatModelSelectionAvailable({
        provider: "anthropic",
        modelId: "claude-retired-model",
        orgAIConfig,
      }),
    ).toBe(false);
  });

  test("rejects a catalog model whose provider the org has not configured", () => {
    // Org only configured anthropic; openai is a real catalog provider/model
    // pair but has no key on this org.
    const orgAIConfig = orgConfigForProviders(["anthropic"]);
    expect(
      isChatModelSelectionAvailable({
        provider: "openai",
        modelId: "gpt-5.4",
        orgAIConfig,
      }),
    ).toBe(false);
  });

  test("every offered chat-role model is available once its provider is configured", () => {
    // The catalog only restricts by input modality for the "pdf" role, so
    // for "chat" every BYOK_MODEL_OPTIONS entry must be available. Iterating
    // the full catalog guards against a future catalog change accidentally
    // scoping a model away from the chat role.
    for (const provider of TANSTACK_AI_PROVIDERS) {
      const orgAIConfig = orgConfigForProviders([provider]);
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        expect(
          isChatModelSelectionAvailable({ provider, modelId, orgAIConfig }),
        ).toBe(true);
      }
    }
  });

  test("falls back to the single instance provider when no org config exists", () => {
    expect(
      isChatModelSelectionAvailable({
        provider: "openai",
        modelId: "gpt-5.4",
        orgAIConfig: null,
      }),
    ).toBe(true);
    expect(
      isChatModelSelectionAvailable({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        orgAIConfig: null,
      }),
    ).toBe(false);
  });
});

describe("getConfiguredChatModelOptions", () => {
  test("only lists models for providers the org configured", () => {
    const orgAIConfig = orgConfigForProviders(["anthropic", "mistral"]);
    const options = getConfiguredChatModelOptions(orgAIConfig);
    const providers = new Set(options.map((option) => option.provider));
    expect(providers).toEqual(new Set(["anthropic", "mistral"]));
    expect(options.length).toBe(
      BYOK_MODEL_OPTIONS.anthropic.length + BYOK_MODEL_OPTIONS.mistral.length,
    );
  });

  test("returns no options for an org with no configured providers", () => {
    expect(getConfiguredChatModelOptions(orgConfigForProviders([]))).toEqual(
      [],
    );
  });

  test("every row has friendly display metadata and only adapter-supported efforts", () => {
    const options = getConfiguredChatModelOptions(
      orgConfigForProviders([...TANSTACK_AI_PROVIDERS]),
    );
    for (const option of options) {
      expect(option.displayName.length).toBeGreaterThan(0);
      expect(option.iconProvider.length).toBeGreaterThan(0);
      expect(option.displayName).not.toContain("/");
      expect(option.reasoningEfforts).toEqual(
        getChatModelReasoningEfforts(option),
      );
      if (
        option.provider === "openrouter" &&
        option.reasoningEfforts !== null
      ) {
        expect(option.defaultReasoningEffort).not.toBeNull();
        if (option.defaultReasoningEffort !== null) {
          expect(option.reasoningEfforts).toContain(
            option.defaultReasoningEffort,
          );
        }
      } else {
        expect(option.defaultReasoningEffort).toBeNull();
      }
      if (option.provider === "bedrock" || option.provider === "mistral") {
        expect(option.reasoningEfforts).toBeNull();
      }
    }
  });
});

describe("getDefaultChatModelValue", () => {
  test("resolves the org's configured chat-role default", () => {
    const orgAIConfig = orgConfigForProviders(["anthropic"]);
    expect(
      getDefaultChatModelValue({ orgAIConfig, organizationId: null }),
    ).toBe(
      encodeChatModelSelection({
        provider: "anthropic",
        modelId: orgAIConfig.overrideModels.chat.modelId,
      }),
    );
  });

  test("returns null when neither an org nor an instance provider is configured", () => {
    expect(
      getDefaultChatModelValue({
        orgAIConfig: orgConfigForProviders([]),
        organizationId: null,
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveChatModelId", () => {
  const orgAIConfig = orgConfigForProviders(["anthropic"]);
  const validThreadOverride = encodeChatModelSelection({
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
  });

  test("the dev override always wins", () => {
    expect(
      resolveEffectiveChatModelId({
        devModelId: "anthropic::claude-opus-4-7",
        threadChatModel: validThreadOverride,
        orgAIConfig,
      }),
    ).toBe("anthropic::claude-opus-4-7");
  });

  test("a valid thread override is used absent a dev override", () => {
    expect(
      resolveEffectiveChatModelId({
        devModelId: undefined,
        threadChatModel: validThreadOverride,
        orgAIConfig,
      }),
    ).toBe(validThreadOverride);
  });

  test("no thread override falls through to undefined (org default)", () => {
    expect(
      resolveEffectiveChatModelId({
        devModelId: undefined,
        threadChatModel: null,
        orgAIConfig,
      }),
    ).toBeUndefined();
  });

  test("a stale thread override (provider key removed) falls back to undefined", () => {
    // Org no longer has anthropic configured (e.g. the key was removed
    // after the thread override was written).
    const orgAIConfigWithoutAnthropic = orgConfigForProviders(["mistral"]);
    expect(
      resolveEffectiveChatModelId({
        devModelId: undefined,
        threadChatModel: validThreadOverride,
        orgAIConfig: orgAIConfigWithoutAnthropic,
      }),
    ).toBeUndefined();
  });

  test("a malformed thread override falls back to undefined", () => {
    expect(
      resolveEffectiveChatModelId({
        devModelId: undefined,
        threadChatModel: "not-a-valid-encoding",
        orgAIConfig,
      }),
    ).toBeUndefined();
  });

  test("a thread override for a retired catalog model falls back to undefined", () => {
    expect(
      resolveEffectiveChatModelId({
        devModelId: undefined,
        threadChatModel: encodeChatModelSelection({
          provider: "anthropic",
          modelId: "claude-retired-model",
        }),
        orgAIConfig,
      }),
    ).toBeUndefined();
  });
});

describe("resolveEffectiveChatModelSelection", () => {
  const orgAIConfig = orgConfigForProviders(["openai"]);
  const model = encodeChatModelSelection({
    provider: "openai",
    modelId: "gpt-5.5",
  });

  test("keeps an available manual model and effort together", () => {
    expect(
      resolveEffectiveChatModelSelection({
        devModelId: undefined,
        threadChatModel: model,
        threadReasoningEffort: "high",
        orgAIConfig,
      }),
    ).toEqual({ modelId: model, reasoningEffort: "high" });
    expect(
      isChatModelReasoningEffortAvailable({
        provider: "openai",
        modelId: "gpt-5.5",
        reasoningEffort: "high",
      }),
    ).toBe(true);
  });

  test("drops stale effort without dropping an available model", () => {
    expect(
      resolveEffectiveChatModelSelection({
        devModelId: undefined,
        threadChatModel: model,
        threadReasoningEffort: "max",
        orgAIConfig,
      }),
    ).toEqual({ modelId: model, reasoningEffort: undefined });
  });

  test("Auto and dev overrides never inherit a thread effort", () => {
    expect(
      resolveEffectiveChatModelSelection({
        devModelId: undefined,
        threadChatModel: null,
        threadReasoningEffort: null,
        orgAIConfig,
      }),
    ).toEqual({ modelId: undefined, reasoningEffort: undefined });
    expect(
      resolveEffectiveChatModelSelection({
        devModelId: "openai::gpt-5.4",
        threadChatModel: model,
        threadReasoningEffort: "high",
        orgAIConfig,
      }),
    ).toEqual({
      modelId: "openai::gpt-5.4",
      reasoningEffort: undefined,
    });
  });
});
