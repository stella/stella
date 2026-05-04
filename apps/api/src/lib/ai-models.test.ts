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
  DEFAULT_MODELS,
  getModelForRole,
  getModelInfoForRole,
  REGIONAL_PROVIDERS,
  supportsRegion,
} = await import("@/api/lib/ai-models");

type AIProvider =
  | "google"
  | "openrouter"
  | "openai"
  | "anthropic"
  | "openai_compatible";

describe("supportsRegion", () => {
  test("google supports regional routing", () => {
    expect(supportsRegion("google")).toBe(true);
  });

  test("non-google providers do not support regional routing", () => {
    const nonRegional: AIProvider[] = [
      "openrouter",
      "openai",
      "anthropic",
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

describe("BYOK model overrides", () => {
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

  test("falls back to the primary provider default when a role has no selection", () => {
    const orgConfig: OrgAIConfig = {
      providers: [
        {
          apiKey: "sk-org",
          provider: "anthropic",
        },
      ],
    };

    expect(getModelInfoForRole("fast", orgConfig)).toMatchObject({
      keySource: "byok",
      modelId: DEFAULT_MODELS.anthropic.fast,
      provider: "anthropic",
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
        modelId: orgConfig.overrideModels?.[role]?.modelId,
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
        reasoning: { provider: "openai", modelId: "gpt-5.4-pro" },
      },
    };

    expect(() => getModelForRole("reasoning", orgConfig)).not.toThrow();
    expect(getModelInfoForRole("reasoning", orgConfig).modelId).toBe(
      "gpt-5.4-pro",
    );
  });
});
