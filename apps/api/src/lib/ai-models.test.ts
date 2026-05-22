import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { OrgAIConfig } from "@/api/lib/ai-models";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["AI_PROVIDER"] = "openai";
process.env["OPENAI_API_KEY"] ??= "sk-instance";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

const {
  getModelForRole,
  getModelInfoById,
  getModelInfoForRole,
  isAllowedBYOKModel,
  REGIONAL_PROVIDERS,
  supportsRegion,
  validateDevModelOverride,
} = await import("@/api/lib/ai-models");

type AIProvider =
  | "google"
  | "openrouter"
  | "openai"
  | "azure_foundry"
  | "anthropic"
  | "mistral"
  | "openai_compatible";

describe("supportsRegion", () => {
  test("google supports regional routing", () => {
    expect(supportsRegion("google")).toBe(true);
  });

  test("non-google providers do not support regional routing", () => {
    const nonRegional: AIProvider[] = [
      "openrouter",
      "openai",
      "azure_foundry",
      "anthropic",
      "mistral",
      "openai_compatible",
    ];

    for (const provider of nonRegional) {
      expect(supportsRegion(provider)).toBe(false);
    }
  });
});

describe("REGIONAL_PROVIDERS", () => {
  test("contains exactly one provider (google)", () => {
    expect(REGIONAL_PROVIDERS.size).toBe(1);
    expect(REGIONAL_PROVIDERS.has("google")).toBe(true);
  });
});

describe("isAllowedBYOKModel", () => {
  test("accepts curated catalog models", () => {
    expect(isAllowedBYOKModel("anthropic", "claude-opus-4-7")).toBe(true);
    expect(isAllowedBYOKModel("google", "gemini-3.5-flash")).toBe(true);
    expect(isAllowedBYOKModel("mistral", "mistral-medium-3-5")).toBe(true);
    expect(isAllowedBYOKModel("mistral", "mistral-large-latest")).toBe(true);
    expect(isAllowedBYOKModel("openai", "gpt-5.4")).toBe(true);
    expect(isAllowedBYOKModel("azure_foundry", "customer-gpt-5")).toBe(true);
    expect(isAllowedBYOKModel("openrouter", "anthropic/claude-opus-4.5")).toBe(
      true,
    );
  });

  test("rejects models outside the curated catalog", () => {
    expect(isAllowedBYOKModel("openrouter", "x-ai/grok-4")).toBe(false);
    expect(isAllowedBYOKModel("anthropic", "claude-2")).toBe(false);
    expect(isAllowedBYOKModel("google", "gemini-2.5-pro")).toBe(false);
    expect(isAllowedBYOKModel("mistral", "pixtral-large-latest")).toBe(false);
    expect(isAllowedBYOKModel("mistral", "mistral-tiny")).toBe(false);
    expect(isAllowedBYOKModel("openai", "gpt-4o")).toBe(false);
    expect(isAllowedBYOKModel("azure_foundry", "")).toBe(false);
  });

  test("rejects every model id for openai_compatible", () => {
    expect(isAllowedBYOKModel("openai_compatible", "default")).toBe(false);
    expect(isAllowedBYOKModel("openai_compatible", "gpt-5.4")).toBe(false);
  });
});

describe("BYOK model overrides", () => {
  test("reports provider-qualified dev model overrides", () => {
    expect(
      getModelInfoById("openrouter::google/gemini-3.5-flash"),
    ).toMatchObject({
      keySource: "instance",
      modelId: "google/gemini-3.5-flash",
      provider: "openrouter",
    });
  });

  test("routes provider-qualified BYOK dev model overrides through the selected provider", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-org-google",
          provider: "google",
        },
        {
          apiKey: "sk-or-v1-org",
          provider: "openrouter",
        },
      ],
      overrideModels: {
        chat: { provider: "google", modelId: "gemini-3.5-flash" },
        fast: { provider: "google", modelId: "gemini-3.1-flash-lite-preview" },
        reasoning: { provider: "google", modelId: "gemini-3.1-pro-preview" },
        pdf: { provider: "google", modelId: "gemini-3.5-flash" },
      },
    };

    expect(
      getModelInfoById("openrouter::google/gemini-3.5-flash", orgConfig),
    ).toMatchObject({
      keySource: "byok",
      modelId: "google/gemini-3.5-flash",
      provider: "openrouter",
    });
  });

  test("rejects provider-qualified dev overrides without matching BYOK credentials", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-org-google",
          provider: "google",
        },
      ],
      overrideModels: {
        chat: { provider: "google", modelId: "gemini-3.5-flash" },
        fast: { provider: "google", modelId: "gemini-3.1-flash-lite-preview" },
        reasoning: { provider: "google", modelId: "gemini-3.1-pro-preview" },
        pdf: { provider: "google", modelId: "gemini-3.5-flash" },
      },
    };

    const result = validateDevModelOverride(
      "openrouter::google/gemini-3.5-flash",
      orgConfig,
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected provider validation to fail");
    }
    expect(result.error.status).toBe(400);
    expect(result.error.message).toContain("openrouter");
  });

  test("allows provider-qualified dev overrides with matching BYOK credentials", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-org-google",
          provider: "google",
        },
        {
          apiKey: "sk-or-v1-org",
          provider: "openrouter",
        },
      ],
      overrideModels: {
        chat: { provider: "google", modelId: "gemini-3.5-flash" },
        fast: { provider: "google", modelId: "gemini-3.1-flash-lite-preview" },
        reasoning: { provider: "google", modelId: "gemini-3.1-pro-preview" },
        pdf: { provider: "google", modelId: "gemini-3.5-flash" },
      },
    };

    expect(
      Result.isOk(
        validateDevModelOverride(
          "openrouter::google/gemini-3.5-flash",
          orgConfig,
        ),
      ),
    ).toBe(true);
  });

  test("uses a per-role provider-qualified model selection", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-org-anthropic",
          provider: "anthropic",
        },
        {
          apiKey: "sk-org-openai",
          provider: "openai",
        },
      ],
      overrideModels: {
        chat: { provider: "anthropic", modelId: "claude-opus-4-5" },
        fast: { provider: "openai", modelId: "gpt-5.4-nano" },
        reasoning: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
        pdf: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      },
    };

    expect(getModelInfoForRole("chat", orgConfig)).toMatchObject({
      keySource: "byok",
      modelId: "claude-opus-4-5",
      provider: "anthropic",
    });
    expect(getModelInfoForRole("fast", orgConfig)).toMatchObject({
      keySource: "byok",
      modelId: "gpt-5.4-nano",
      provider: "openai",
    });
  });

  test("reports the selected provider region for BYOK calls", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-google",
          provider: "google",
          region: "eu",
        },
      ],
      overrideModels: {
        pdf: {
          provider: "google",
          modelId: "gemini-3.1-flash-lite-preview",
        },
        chat: {
          provider: "google",
          modelId: "gemini-3.1-flash-lite-preview",
        },
        fast: {
          provider: "google",
          modelId: "gemini-3.1-flash-lite-preview",
        },
        reasoning: {
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
        },
      },
    };

    expect(getModelInfoForRole("pdf", orgConfig)).toMatchObject({
      keySource: "byok",
      provider: "google",
      region: "eu",
    });
  });

  test("routes every Stella role through configured OpenRouter models", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-or-v1-org",
          provider: "openrouter",
        },
      ],
      overrideModels: {
        fast: {
          provider: "openrouter",
          modelId: "google/gemini-3.1-flash-lite-preview",
        },
        chat: {
          provider: "openrouter",
          modelId: "anthropic/claude-sonnet-4.5",
        },
        reasoning: {
          provider: "openrouter",
          modelId: "google/gemini-3.1-pro-preview",
        },
        pdf: {
          provider: "openrouter",
          modelId: "google/gemini-3.1-flash-lite-preview",
        },
      },
    };

    for (const role of ["fast", "chat", "reasoning", "pdf"] as const) {
      expect(getModelInfoForRole(role, orgConfig)).toMatchObject({
        keySource: "byok",
        provider: "openrouter",
        modelId: orgConfig.overrideModels[role].modelId,
      });
      expect(() => getModelForRole(role, orgConfig)).not.toThrow();
    }
  });

  test("routes every Stella role through configured Mistral models", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-org-mistral",
          provider: "mistral",
        },
      ],
      overrideModels: {
        fast: {
          provider: "mistral",
          modelId: "mistral-small-latest",
        },
        chat: {
          provider: "mistral",
          modelId: "mistral-large-latest",
        },
        reasoning: {
          provider: "mistral",
          modelId: "magistral-medium-latest",
        },
        pdf: {
          provider: "mistral",
          modelId: "mistral-large-latest",
        },
      },
    };

    for (const role of ["fast", "chat", "reasoning", "pdf"] as const) {
      expect(getModelInfoForRole(role, orgConfig)).toMatchObject({
        keySource: "byok",
        provider: "mistral",
        modelId: orgConfig.overrideModels[role].modelId,
      });
      expect(() => getModelForRole(role, orgConfig)).not.toThrow();
    }
  });

  test("getModelForRole accepts the configured override model id", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-org",
          provider: "openai",
        },
      ],
      overrideModels: {
        chat: { provider: "openai", modelId: "gpt-5.4-mini" },
        fast: { provider: "openai", modelId: "gpt-5.4-nano" },
        reasoning: { provider: "openai", modelId: "gpt-5.4-pro" },
        pdf: { provider: "openai", modelId: "gpt-5.4" },
      },
    };

    expect(() => getModelForRole("reasoning", orgConfig)).not.toThrow();
    expect(getModelInfoForRole("reasoning", orgConfig).modelId).toBe(
      "gpt-5.4-pro",
    );
  });

  test("routes Azure Foundry BYOK through deployment names", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "azure-org",
          baseURL: "https://example.openai.azure.com/openai",
          provider: "azure_foundry",
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
    };

    expect(getModelInfoForRole("chat", orgConfig)).toMatchObject({
      keySource: "byok",
      modelId: "customer-chat",
      provider: "azure_foundry",
    });
    expect(() => getModelForRole("chat", orgConfig)).not.toThrow();
  });
});
