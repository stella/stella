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
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["SMTP_HOST"] ??= "localhost";
process.env["SMTP_PORT"] ??= "1025";

env.AI_PROVIDER = "openai";
env.OPENAI_API_KEY = "test-openai-instance-key";
env.OPENROUTER_API_KEY = "test-openrouter-instance-key";

const {
  getTanStackTextModelInfoForRole,
  getTanStackTextModelById,
  getTanStackTextModelForRole,
  hasTanStackInstanceProvider,
  isAllowedBYOKModel,
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
  });

  test("fails explicitly for providers without a TanStack migration path", () => {
    expect(resolveTanStackAIProviderSupport({ provider: "mistral" })).toEqual({
      supported: false,
      reason: "provider-not-implemented",
      message: "Mistral is not supported by the TanStack AI integration yet.",
    });
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
  });

  test("rejects unsupported providers and models outside the catalog", () => {
    expect(isAllowedBYOKModel("openrouter", "x-ai/grok-4")).toBe(false);
    expect(isAllowedBYOKModel("anthropic", "claude-2")).toBe(false);
    expect(isAllowedBYOKModel("google", "gemini-2.5-pro")).toBe(false);
    expect(isAllowedBYOKModel("mistral", "mistral-medium-3-5")).toBe(false);
    expect(isAllowedBYOKModel("azure_foundry", "customer-gpt-5")).toBe(false);
    expect(isAllowedBYOKModel("huggingface", "customer-model")).toBe(false);
    expect(isAllowedBYOKModel("openai_compatible", "default")).toBe(false);
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

  test("rejects Mistral BYOK selections before constructing an adapter", () => {
    const orgConfig = orgConfigForProvider("mistral");

    expect(() =>
      getTanStackTextModelForRole("chat", orgConfig, {
        organizationId: orgId,
      }),
    ).toThrow(HandlerError);
  });

  test("rejects Google regional BYOK selections before constructing an adapter", () => {
    const orgConfig = orgConfigForProvider("google", "eu");

    let handlerError: unknown;
    try {
      getTanStackTextModelForRole("chat", orgConfig, {
        organizationId: orgId,
      });
    } catch (error) {
      handlerError = error;
    }

    if (!(handlerError instanceof HandlerError)) {
      throw new Error("Expected HandlerError");
    }
    expect(handlerError.status).toBe(400);
    expect(handlerError.message).toContain("Google regional routing");
  });

  test("reports TanStack availability per selected role", () => {
    expect(
      requireTanStackAIAvailableForRole({
        orgConfig: orgConfigForProvider("openai"),
        role: "chat",
      }).isOk(),
    ).toBe(true);

    const unavailable = requireTanStackAIAvailableForRole({
      orgConfig: orgConfigForProvider("mistral"),
      role: "chat",
    });

    expect(unavailable.isErr()).toBe(true);
    if (unavailable.isErr()) {
      expect(unavailable.error.status).toBe(400);
      expect(unavailable.error.message).toContain("Mistral");
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
  provider: "anthropic" | "google" | "mistral" | "openai" | "openrouter",
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
