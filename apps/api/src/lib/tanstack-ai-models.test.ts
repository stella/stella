import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

process.env["EMAIL_PROVIDER"] ??= "smtp";
process.env["GOTENBERG_PASSWORD"] ??= "gotenberg";
process.env["GOTENBERG_URL"] ??= "http://localhost:3003";
process.env["GOTENBERG_USERNAME"] ??= "gotenberg";
process.env["AI_PROVIDER"] = "openai";
process.env["OPENAI_API_KEY"] ??= "test-openai-instance-key";
process.env["OPENROUTER_API_KEY"] ??= "test-openrouter-instance-key";
process.env["BEDROCK_API_KEY"] ??= "test-bedrock-instance-key";
process.env["MISTRAL_API_KEY"] ??= "test-mistral-instance-key";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

env.AI_PROVIDER = "openai";
env.OPENAI_API_KEY = "test-openai-instance-key";
env.OPENROUTER_API_KEY = "test-openrouter-instance-key";
env.BEDROCK_API_KEY = "test-bedrock-instance-key";
env.MISTRAL_API_KEY = "test-mistral-instance-key";

const {
  getTanStackTextModelInfoForRole,
  getTanStackTextModelById,
  getTanStackTextModelForRole,
  hasTanStackInstanceProvider,
  isAllowedBYOKModel,
  isAllowedBYOKModelForRole,
  isDeferredServiceTierAvailableForRole,
  isTanStackAIProviderSupported,
  requireTanStackAIAvailableForRole,
  resolveEffectiveServiceTierForProvider,
  resolveTanStackAIProviderSupport,
  tanStackModelOptionsForRole,
} = await import("@/api/lib/tanstack-ai-models");

const orgId = toSafeId<"organization">("org_test_tanstack_ai");

describe("resolveTanStackAIProviderSupport", () => {
  test("supports providers with a TanStack text adapter path", () => {
    expect(isTanStackAIProviderSupported({ provider: "openai" })).toBe(true);
    expect(isTanStackAIProviderSupported({ provider: "anthropic" })).toBe(true);
    expect(isTanStackAIProviderSupported({ provider: "openrouter" })).toBe(
      true,
    );
    expect(isTanStackAIProviderSupported({ provider: "bedrock" })).toBe(true);
    expect(isTanStackAIProviderSupported({ provider: "mistral" })).toBe(true);
  });

  test("fails explicitly for providers without a TanStack migration path", () => {
    expect(
      resolveTanStackAIProviderSupport({ provider: "azure_foundry" }),
    ).toMatchObject({
      supported: false,
      reason: "provider-not-implemented",
    });
    expect(
      resolveTanStackAIProviderSupport({ provider: "openai_compatible" }),
    ).toMatchObject({
      supported: false,
      reason: "provider-not-implemented",
    });
    expect(
      resolveTanStackAIProviderSupport({ provider: "huggingface" }),
    ).toMatchObject({
      supported: false,
      reason: "provider-not-implemented",
    });
  });

  test("fails explicitly for Google regional routing", () => {
    expect(
      resolveTanStackAIProviderSupport({
        provider: "google",
        region: "eu",
      }),
    ).toMatchObject({
      supported: false,
      reason: "regional-routing-not-implemented",
    });
    expect(
      resolveTanStackAIProviderSupport({
        provider: "google",
        region: "global",
      }),
    ).toEqual({ supported: true });
  });
});

describe("isAllowedBYOKModel", () => {
  test("accepts curated TanStack BYOK catalog models", () => {
    expect(isAllowedBYOKModel("anthropic", "claude-opus-4-7")).toBe(true);
    expect(isAllowedBYOKModel("google", "gemini-3.5-flash")).toBe(true);
    expect(isAllowedBYOKModel("openai", "gpt-5.4")).toBe(true);
    expect(isAllowedBYOKModel("openrouter", "anthropic/claude-opus-4.8")).toBe(
      true,
    );
    expect(isAllowedBYOKModel("mistral", "mistral-large-latest")).toBe(true);
    expect(
      isAllowedBYOKModel(
        "bedrock",
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      ),
    ).toBe(true);
  });

  test("rejects unsupported providers and models outside the catalog", () => {
    expect(isAllowedBYOKModel("openrouter", "x-ai/grok-4")).toBe(false);
    expect(isAllowedBYOKModel("anthropic", "claude-2")).toBe(false);
    expect(isAllowedBYOKModel("google", "gemini-2.5-pro")).toBe(false);
    expect(isAllowedBYOKModel("mistral", "mistral-medium-3-5")).toBe(false);
    expect(isAllowedBYOKModel("bedrock", "us.amazon.titan-text-lite-v1")).toBe(
      false,
    );
    expect(isAllowedBYOKModel("azure_foundry", "customer-gpt-5")).toBe(false);
    expect(isAllowedBYOKModel("huggingface", "customer-model")).toBe(false);
    expect(isAllowedBYOKModel("openai_compatible", "default")).toBe(false);
  });

  test("rejects catalog models for roles their provider cannot serve", () => {
    expect(
      isAllowedBYOKModelForRole({
        provider: "mistral",
        modelId: "mistral-large-latest",
        role: "chat",
      }),
    ).toBe(true);
    expect(
      isAllowedBYOKModelForRole({
        provider: "mistral",
        modelId: "mistral-large-latest",
        role: "pdf",
      }),
    ).toBe(false);
    expect(
      isAllowedBYOKModelForRole({
        provider: "openai",
        modelId: "gpt-5.4",
        role: "pdf",
      }),
    ).toBe(true);
  });
});

describe("TanStack service tiers", () => {
  test("keeps deferred tiers only for supported providers with matching options", () => {
    expect(
      resolveEffectiveServiceTierForProvider({
        provider: "google",
        serviceTier: "flex",
      }),
    ).toBe("flex");
    expect(
      resolveEffectiveServiceTierForProvider({
        provider: "openai",
        serviceTier: "batch",
      }),
    ).toBe("batch");
    expect(
      resolveEffectiveServiceTierForProvider({
        provider: "openrouter",
        serviceTier: "flex",
      }),
    ).toBe("flex");
    expect(
      resolveEffectiveServiceTierForProvider({
        provider: "anthropic",
        serviceTier: "flex",
      }),
    ).toBe("standard");
  });

  test("downgrades unsupported providers and regional Google to standard", () => {
    expect(
      resolveEffectiveServiceTierForProvider({
        provider: "mistral",
        serviceTier: "flex",
      }),
    ).toBe("standard");
    expect(
      resolveEffectiveServiceTierForProvider({
        provider: "bedrock",
        serviceTier: "flex",
      }),
    ).toBe("standard");
    expect(
      resolveEffectiveServiceTierForProvider({
        provider: "google",
        region: "eu",
        serviceTier: "flex",
      }),
    ).toBe("standard");
  });

  test("reports deferred availability from the selected role provider", () => {
    expect(
      isDeferredServiceTierAvailableForRole(
        "chat",
        orgConfigForProvider("openrouter"),
      ),
    ).toBe(true);
    expect(
      isDeferredServiceTierAvailableForRole(
        "chat",
        orgConfigForProvider("anthropic"),
      ),
    ).toBe(false);
  });
});

describe("TanStack text model resolution", () => {
  test("reports an instance provider only when TanStack can serve it", () => {
    expect(hasTanStackInstanceProvider()).toBe(true);
  });

  test("allows explicit Bedrock instance provider to use SigV4 without a bearer key", () => {
    const originalEnv = {
      AI_PROVIDER: env.AI_PROVIDER,
      BEDROCK_API_KEY: env.BEDROCK_API_KEY,
    };
    const originalProcessBedrockApiKey = process.env["BEDROCK_API_KEY"];

    try {
      env.AI_PROVIDER = "bedrock";
      env.BEDROCK_API_KEY = undefined;
      delete process.env["BEDROCK_API_KEY"];

      const model = getTanStackTextModelForRole("chat", null, {
        organizationId: orgId,
      });

      expect(hasTanStackInstanceProvider()).toBe(true);
      expect(model).toMatchObject({
        keySource: "instance",
        provider: "bedrock",
      });
      expect(model.adapter.name).toBe("bedrock-converse");
    } finally {
      Object.assign(env, originalEnv);
      if (originalProcessBedrockApiKey === undefined) {
        delete process.env["BEDROCK_API_KEY"];
      } else {
        process.env["BEDROCK_API_KEY"] = originalProcessBedrockApiKey;
      }
    }
  });

  test("auto-detects Mistral when stale unsupported provider credentials exist", () => {
    const originalEnv = {
      AI_PROVIDER: env.AI_PROVIDER,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      AZURE_API_KEY: env.AZURE_API_KEY,
      AZURE_BASE_URL: env.AZURE_BASE_URL,
      AZURE_RESOURCE_NAME: env.AZURE_RESOURCE_NAME,
      BEDROCK_API_KEY: env.BEDROCK_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY,
      HUGGINGFACE_API_KEY: env.HUGGINGFACE_API_KEY,
      HUGGINGFACE_BASE_URL: env.HUGGINGFACE_BASE_URL,
      MISTRAL_API_KEY: env.MISTRAL_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    };

    try {
      env.AI_PROVIDER = undefined;
      env.ANTHROPIC_API_KEY = undefined;
      env.BEDROCK_API_KEY = undefined;
      env.GOOGLE_GENERATIVE_AI_API_KEY = undefined;
      env.OPENAI_API_KEY = undefined;
      env.OPENROUTER_API_KEY = undefined;
      env.AZURE_API_KEY = "test-azure-key";
      env.AZURE_BASE_URL = "https://example.openai.azure.com/openai";
      env.HUGGINGFACE_API_KEY = "test-hf-key";
      env.HUGGINGFACE_BASE_URL =
        "https://example.endpoints.huggingface.cloud/v1";
      env.MISTRAL_API_KEY = "test-mistral-instance-key";

      const model = getTanStackTextModelForRole("chat", null, {
        organizationId: orgId,
      });

      expect(hasTanStackInstanceProvider()).toBe(true);
      expect(model.provider).toBe("mistral");
      expect(model.adapter.name).toBe("mistral");
    } finally {
      Object.assign(env, originalEnv);
    }
  });

  test("resolves instance OpenAI models through an arbitrary-id compatible adapter", () => {
    const model = getTanStackTextModelById("openai::gpt-5.4", null, {
      role: "reasoning",
      organizationId: orgId,
    });

    expect(model).toMatchObject({
      keySource: "instance",
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(model.adapter.name).toBe("openai");
    expect(model.adapter.model).toBe("gpt-5.4");
    expect(model.modelOptions).toMatchObject({
      temperature: 0,
      reasoning: { effort: "medium" },
    });
  });

  test("routes provider-qualified explicit ids through configured OpenRouter credentials", () => {
    const model = getTanStackTextModelById(
      "openrouter::google/gemini-3.5-flash",
      null,
      { role: "chat", organizationId: null },
    );

    expect(model).toMatchObject({
      keySource: "instance",
      provider: "openrouter",
      modelId: "google/gemini-3.5-flash",
    });
    expect(model.adapter.name).toBe("openrouter-responses");
    expect(model.adapter.model).toBe("google/gemini-3.5-flash");
  });

  test("resolves Mistral BYOK selections through the TanStack adapter", () => {
    const orgConfig = orgConfigForProvider("mistral");

    const model = getTanStackTextModelForRole("chat", orgConfig, {
      organizationId: orgId,
    });

    expect(model).toMatchObject({
      keySource: "byok",
      provider: "mistral",
      modelId: "model-chat",
      modelOptions: { temperature: 0 },
    });
    expect(model.adapter.name).toBe("mistral");
  });

  test("rejects Mistral BYOK selections for PDF flows", () => {
    let handlerError: unknown;
    try {
      getTanStackTextModelForRole("pdf", orgConfigForProvider("mistral"), {
        organizationId: orgId,
      });
    } catch (error) {
      handlerError = error;
    }

    if (!(handlerError instanceof HandlerError)) {
      throw new TypeError("Expected HandlerError");
    }
    expect(handlerError.status).toBe(400);
    expect(handlerError.message).toContain("document input");
  });

  test("rejects stale Bedrock text-only model selections for PDF flows", () => {
    const orgConfig = orgConfigForProvider("bedrock");
    orgConfig.overrideModels.pdf = {
      provider: "bedrock",
      modelId: "us.amazon.nova-micro-v1:0",
    };

    const unavailable = requireTanStackAIAvailableForRole({
      orgConfig,
      role: "pdf",
    });

    expect(unavailable.isErr()).toBe(true);
    if (unavailable.isErr()) {
      expect(unavailable.error.status).toBe(400);
      expect(unavailable.error.message).toContain("document input");
    }

    let handlerError: unknown;
    try {
      getTanStackTextModelForRole("pdf", orgConfig, {
        organizationId: orgId,
      });
    } catch (error) {
      handlerError = error;
    }

    if (!(handlerError instanceof HandlerError)) {
      throw new TypeError("Expected HandlerError");
    }
    expect(handlerError.status).toBe(400);
    expect(handlerError.message).toContain("us.amazon.nova-micro-v1:0");
    expect(handlerError.message).toContain("document input");
  });

  test("rejects unsupported instance providers in role availability preflight", () => {
    const originalProvider = env.AI_PROVIDER;
    try {
      env.AI_PROVIDER = "mistral";

      const unavailable = requireTanStackAIAvailableForRole({
        orgConfig: null,
        role: "pdf",
      });

      expect(unavailable.isErr()).toBe(true);
      if (unavailable.isErr()) {
        expect(unavailable.error.status).toBe(400);
        expect(unavailable.error.message).toContain("PDF flows");
      }
    } finally {
      env.AI_PROVIDER = originalProvider;
    }
  });

  test("resolves Bedrock BYOK selections through the TanStack adapter", () => {
    const orgConfig = orgConfigForProvider("bedrock");

    const model = getTanStackTextModelForRole("chat", orgConfig, {
      organizationId: orgId,
    });

    expect(model).toMatchObject({
      keySource: "byok",
      provider: "bedrock",
      modelId: "model-chat",
      modelOptions: { temperature: 0 },
    });
    expect(model.adapter.name).toBe("bedrock-converse");
  });

  test("normalizes existing Google regional BYOK selections to global", () => {
    const orgConfig = orgConfigForProvider("google", "eu");

    const model = getTanStackTextModelForRole("chat", orgConfig, {
      organizationId: orgId,
    });

    expect(model).toMatchObject({
      keySource: "byok",
      provider: "google",
      region: "global",
    });
    expect(model.adapter.name).toBe("gemini");
  });

  test("reports TanStack availability per selected role", () => {
    expect(
      requireTanStackAIAvailableForRole({
        orgConfig: orgConfigForProvider("openai"),
        role: "chat",
      }).isOk(),
    ).toBe(true);

    const unavailable = requireTanStackAIAvailableForRole({
      orgConfig: orgConfigForProvider("openai_compatible"),
      role: "chat",
    });

    expect(unavailable.isErr()).toBe(true);
    if (unavailable.isErr()) {
      expect(unavailable.error.status).toBe(400);
      expect(unavailable.error.message).toContain("OpenAI-compatible");
    }

    const unsupportedRole = requireTanStackAIAvailableForRole({
      orgConfig: orgConfigForProvider("mistral"),
      role: "pdf",
    });

    expect(unsupportedRole.isErr()).toBe(true);
    if (unsupportedRole.isErr()) {
      expect(unsupportedRole.error.status).toBe(400);
      expect(unsupportedRole.error.message).toContain("PDF flows");
    }
  });

  test("exposes TanStack model metadata without leaking the adapter", () => {
    const modelInfo = getTanStackTextModelInfoForRole(
      "chat",
      orgConfigForProvider("openrouter"),
      { organizationId: orgId },
    );

    expect(modelInfo).toEqual({
      keySource: "byok",
      provider: "openrouter",
      region: "global",
      modelId: "model-chat",
    });
    expect(modelInfo).not.toHaveProperty("adapter");
    expect(modelInfo).not.toHaveProperty("modelOptions");
  });
});

describe("tanStackModelOptionsForRole", () => {
  test("keeps deterministic sampling for OpenRouter", () => {
    expect(
      tanStackModelOptionsForRole({
        role: "chat",
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4.6",
        organizationId: null,
      }),
    ).toEqual({ temperature: 0 });
  });

  test("preserves OpenRouter per-role reasoning controls", () => {
    expect(
      tanStackModelOptionsForRole({
        role: "fast",
        provider: "openrouter",
        modelId: "google/gemini-3.5-flash",
        organizationId: null,
      }),
    ).toMatchObject({
      reasoning: { effort: "none" },
      temperature: 0,
    });
    expect(
      tanStackModelOptionsForRole({
        role: "reasoning",
        provider: "openrouter",
        modelId: "google/gemini-3.5-pro",
        organizationId: null,
      }),
    ).toMatchObject({
      reasoning: { effort: "high" },
      temperature: 0,
    });
  });

  test("uses TanStack Anthropic snake_case thinking options", () => {
    expect(
      tanStackModelOptionsForRole({
        role: "reasoning",
        provider: "anthropic",
        modelId: "claude-haiku-4-5-20251001",
        organizationId: orgId,
      }),
    ).toMatchObject({
      thinking: {
        type: "enabled",
        budget_tokens: 10_000,
      },
    });
  });

  test("uses adaptive Anthropic thinking for newer Claude models", () => {
    expect(
      tanStackModelOptionsForRole({
        role: "reasoning",
        provider: "anthropic",
        modelId: "claude-opus-4-8",
        organizationId: orgId,
      }),
    ).toMatchObject({
      thinking: {
        type: "adaptive",
      },
    });
  });

  test("does not emit unsupported Anthropic user metadata", () => {
    const options = tanStackModelOptionsForRole({
      role: "chat",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      organizationId: orgId,
    });

    expect(options).not.toHaveProperty("user_id");
  });

  test("omits sampling for Anthropic fixed-sampling models", () => {
    const options = tanStackModelOptionsForRole({
      role: "chat",
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      organizationId: null,
    });

    expect(options).not.toHaveProperty("temperature");
  });
});

const orgConfigForProvider = (
  provider:
    | "anthropic"
    | "bedrock"
    | "google"
    | "mistral"
    | "openai"
    | "openai_compatible"
    | "openrouter",
  region?: "eu" | "global" | "ch",
): OrgAIConfig => ({
  providers: [
    {
      provider,
      apiKey: "test-org-provider-key",
      ...(region === undefined ? {} : { region }),
    },
  ],
  overrideModels: {
    fast: { provider, modelId: "model-fast" },
    chat: { provider, modelId: "model-chat" },
    reasoning: { provider, modelId: "model-reasoning" },
    pdf: { provider, modelId: "model-pdf" },
  },
});
