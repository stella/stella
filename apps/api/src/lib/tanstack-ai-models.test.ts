import { describe, expect, test } from "bun:test";

import {
  BYOK_DOCUMENT_INPUT_MODEL_OPTIONS,
  BYOK_MODEL_OPTIONS,
  CHAT_PDF_ATTACHMENT_MODEL_OPTIONS,
  getModelReasoningEfforts,
  MODEL_ROLES,
  shouldEmitTemperature,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";

import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { StellaOpenRouterTextAdapter } from "@/api/lib/stella-openrouter-text-adapter";
import type { TanStackModelOptions } from "@/api/lib/tanstack-ai-models";

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
  modelAcceptsPdfDocumentInput,
  modelAcceptsTextualDocumentInput,
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
    expect(isAllowedBYOKModel("anthropic", "claude-sonnet-5")).toBe(true);
    expect(isAllowedBYOKModel("google", "gemini-3.7-flash")).toBe(true);
    expect(isAllowedBYOKModel("google", "gemini-3.6-flash")).toBe(true);
    expect(isAllowedBYOKModel("openai", "gpt-5.6")).toBe(true);
    expect(isAllowedBYOKModel("openrouter", "google/gemini-3.7-flash")).toBe(
      true,
    );
    expect(isAllowedBYOKModel("openrouter", "google/gemini-3.6-flash")).toBe(
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

describe("chat document-attachment capability", () => {
  // The chat-send document-attachment gate (stream-chat.ts) rejects a document
  // attachment before dispatch when the resolved model's adapter would throw
  // on it, because some adapters (e.g. Mistral) map only a subset of document
  // formats and crash on the rest. The gate is only correct if these predicates
  // match the catalog's typed capability sets for EVERY offered model, not just
  // the ones we happened to think of. Iterating the whole catalog turns "add a
  // model/provider without wiring its document modality" into a test failure
  // rather than a latent crash: a new model defaults to not document-capable
  // (safe), and these properties pin that to the catalog.
  test.each([...TANSTACK_AI_PROVIDERS])(
    "pins textual + PDF document capability for every offered %s model to the catalog",
    (provider) => {
      const textualCapable: readonly string[] =
        BYOK_DOCUMENT_INPUT_MODEL_OPTIONS[provider];
      const pdfCapable: readonly string[] =
        CHAT_PDF_ATTACHMENT_MODEL_OPTIONS[provider];
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        expect(modelAcceptsTextualDocumentInput({ provider, modelId })).toBe(
          textualCapable.includes(modelId),
        );
        expect(modelAcceptsPdfDocumentInput({ provider, modelId })).toBe(
          pdfCapable.includes(modelId),
        );
        // Superset invariant: anything that takes a textual document also
        // takes a PDF one. A model that accepted text but not PDF would be a
        // catalog bug (the gate would send it a PDF it cannot read).
        if (modelAcceptsTextualDocumentInput({ provider, modelId })) {
          expect(modelAcceptsPdfDocumentInput({ provider, modelId })).toBe(
            true,
          );
        }
      }
    },
  );

  test("Mistral vision models accept PDF but not textual documents; other Mistral models accept neither", () => {
    // Mistral's document_url path takes PDF only, and Mistral is deliberately
    // not a pdf-role provider, so textual documents must never route to it.
    expect(BYOK_DOCUMENT_INPUT_MODEL_OPTIONS.mistral).toHaveLength(0);
    const mistralPdfModels: readonly string[] =
      CHAT_PDF_ATTACHMENT_MODEL_OPTIONS.mistral;
    for (const modelId of BYOK_MODEL_OPTIONS.mistral) {
      expect(
        modelAcceptsTextualDocumentInput({ provider: "mistral", modelId }),
      ).toBe(false);
      expect(
        modelAcceptsPdfDocumentInput({ provider: "mistral", modelId }),
      ).toBe(mistralPdfModels.includes(modelId));
    }
    expect(
      modelAcceptsPdfDocumentInput({
        provider: "mistral",
        modelId: "mistral-large-latest",
      }),
    ).toBe(false);
    expect(
      modelAcceptsPdfDocumentInput({
        provider: "mistral",
        modelId: "mistral-medium-latest",
      }),
    ).toBe(true);
  });

  test("both predicates fail closed for an unrecognized provider", () => {
    expect(
      // @ts-expect-error -- exercising the runtime fail-closed guard for a
      // provider outside the BYOK catalog union.
      modelAcceptsTextualDocumentInput({ provider: "acme", modelId: "x" }),
    ).toBe(false);
    expect(
      // @ts-expect-error -- exercising the runtime fail-closed guard for a
      // provider outside the BYOK catalog union.
      modelAcceptsPdfDocumentInput({ provider: "acme", modelId: "x" }),
    ).toBe(false);
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
    expect(looseOptions(model.modelOptions)).toEqual({
      reasoning: { effort: "medium" },
    });
  });

  test("refuses instance-key dispatch of a model with no published rate", () => {
    expect(() =>
      getTanStackTextModelById("openai::gpt-unrated-experiment", null, {
        role: "chat",
        organizationId: orgId,
      }),
    ).toThrow(
      'Model "gpt-unrated-experiment" is not available on this deployment.',
    );
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
    expect(model.adapter.name).toBe("openrouter");
    expect(model.adapter.model).toBe("google/gemini-3.5-flash");
    expect(model.adapter).toBeInstanceOf(StellaOpenRouterTextAdapter);
  });

  test("keeps the Google provider default for a manual model without an effort", () => {
    const originalKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
    env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    try {
      const model = getTanStackTextModelById("google::gemini-3.6-flash", null, {
        role: "chat",
        organizationId: null,
      });

      expect(looseOptions(model.modelOptions).thinkingConfig).toBeUndefined();
    } finally {
      env.GOOGLE_GENERATIVE_AI_API_KEY = originalKey;
    }
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
    });
    // "model-chat" is not a catalogued id: no sampling params are sent.
    expect(model.modelOptions).toEqual({});
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
      configStatus: ORG_AI_CONFIG_STATUS.ok,
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
        configStatus: ORG_AI_CONFIG_STATUS.ok,
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
    });
    // "model-chat" is not a catalogued id: no sampling params are sent.
    expect(model.modelOptions).toEqual({});
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
        configStatus: ORG_AI_CONFIG_STATUS.ok,
        orgConfig: orgConfigForProvider("openai"),
        role: "chat",
      }).isOk(),
    ).toBe(true);

    const unavailable = requireTanStackAIAvailableForRole({
      configStatus: ORG_AI_CONFIG_STATUS.ok,
      orgConfig: orgConfigForProvider("openai_compatible"),
      role: "chat",
    });

    expect(unavailable.isErr()).toBe(true);
    if (unavailable.isErr()) {
      expect(unavailable.error.status).toBe(400);
      expect(unavailable.error.message).toContain("OpenAI-compatible");
    }

    const unsupportedRole = requireTanStackAIAvailableForRole({
      configStatus: ORG_AI_CONFIG_STATUS.ok,
      orgConfig: orgConfigForProvider("mistral"),
      role: "pdf",
    });

    expect(unsupportedRole.isErr()).toBe(true);
    if (unsupportedRole.isErr()) {
      expect(unsupportedRole.error.status).toBe(400);
      expect(unsupportedRole.error.message).toContain("PDF flows");
    }
  });

  test("an unreadable stored organization config is not treated as absent", () => {
    // A stored config that failed to decrypt must not fall back to the
    // shared instance provider, which would route the call somewhere the
    // organization never configured.
    const unreadable = requireTanStackAIAvailableForRole({
      configStatus: ORG_AI_CONFIG_STATUS.unreadable,
      orgConfig: null,
      role: "chat",
    });

    expect(unreadable.isErr()).toBe(true);
    if (unreadable.isErr()) {
      expect(unreadable.error.status).toBe(503);
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

// Widen branded reasoning fields to plain strings so tests can
// assert emitted values with literals.
type LooseModelOptions = {
  temperature?: number | null | undefined;
  reasoning?: { effort: string } | undefined;
  thinkingConfig?:
    | { thinkingLevel?: string | undefined; includeThoughts?: boolean }
    | undefined;
};
const looseOptions = (options: TanStackModelOptions): LooseModelOptions =>
  options;

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

  test("omits deprecated Gemini sampling parameters across provider paths", () => {
    for (const candidate of [
      { provider: "google" as const, modelId: "gemini-3.6-flash" },
      {
        provider: "openrouter" as const,
        modelId: "google/gemini-3.6-flash",
      },
      { provider: "google" as const, modelId: "gemini-3.5-flash-lite" },
      {
        provider: "openrouter" as const,
        modelId: "google/gemini-3.5-flash-lite",
      },
    ]) {
      const options = tanStackModelOptionsForRole({
        role: "chat",
        organizationId: null,
        ...candidate,
      });
      expect(
        options,
        `${candidate.provider}/${candidate.modelId}`,
      ).not.toHaveProperty("temperature");
    }
  });

  test("clamps the fast-role effort into the model's declared capability", () => {
    // gemini-3.5-flash cannot disable reasoning ("Reasoning is
    // mandatory" 502 class): the fast role's "none" request must
    // degrade to the model's weakest declared tier.
    expect(
      looseOptions(
        tanStackModelOptionsForRole({
          role: "fast",
          provider: "openrouter",
          modelId: "google/gemini-3.5-flash",
          organizationId: null,
        }),
      ),
    ).toMatchObject({
      reasoning: { effort: "minimal" },
      temperature: 0,
    });
    // GPT slugs accept "none"; the request passes through unchanged.
    // No temperature: the GPT-5 family rejects sampling overrides.
    const gptOptions = looseOptions(
      tanStackModelOptionsForRole({
        role: "fast",
        provider: "openrouter",
        modelId: "openai/gpt-5.4-mini",
        organizationId: null,
      }),
    );
    expect(gptOptions).toMatchObject({ reasoning: { effort: "none" } });
    expect(gptOptions.temperature).toBeUndefined();
  });

  test("preserves OpenRouter reasoning-role effort on capable models", () => {
    expect(
      looseOptions(
        tanStackModelOptionsForRole({
          role: "reasoning",
          provider: "openrouter",
          modelId: "google/gemini-3.1-pro-preview",
          organizationId: null,
        }),
      ),
    ).toMatchObject({
      reasoning: { effort: "high" },
      temperature: 0,
    });
  });

  test("manual chat effort reaches each supported provider adapter", () => {
    expect(
      looseOptions(
        tanStackModelOptionsForRole({
          role: "chat",
          provider: "google",
          modelId: "gemini-3.6-flash",
          organizationId: null,
          reasoningEffort: "medium",
        }),
      ),
    ).toMatchObject({ thinkingConfig: { thinkingLevel: "MEDIUM" } });
    expect(
      tanStackModelOptionsForRole({
        role: "chat",
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        organizationId: null,
        reasoningEffort: "high",
      }),
    ).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(
      tanStackModelOptionsForRole({
        role: "chat",
        provider: "openai",
        modelId: "gpt-5.5",
        organizationId: null,
        reasoningEffort: "xhigh",
      }),
    ).toMatchObject({ reasoning: { effort: "xhigh" } });
    expect(
      looseOptions(
        tanStackModelOptionsForRole({
          role: "chat",
          provider: "openrouter",
          modelId: "openai/gpt-5.5",
          organizationId: null,
          reasoningEffort: "low",
        }),
      ),
    ).toMatchObject({ reasoning: { effort: "low" } });
  });

  test("turns Anthropic thinking off when the selected model offers none", () => {
    expect(
      tanStackModelOptionsForRole({
        role: "chat",
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        organizationId: null,
        reasoningEffort: "none",
      }),
    ).toEqual({ thinking: { type: "disabled" } });
  });

  test("never emits a reasoning control outside the model's declared capability", () => {
    // The whole-class invariant behind the "Reasoning is mandatory"
    // 502: for EVERY offered model and role, any effort (or Gemini
    // thinking level) the builders emit must be in the model's
    // declared capability set, and models without one get nothing.
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        for (const role of MODEL_ROLES) {
          const options = looseOptions(
            tanStackModelOptionsForRole({
              role,
              provider,
              modelId,
              organizationId: null,
            }),
          );
          const declared = getModelReasoningEfforts(modelId);
          const declaredValues: readonly string[] = declared ?? [];
          const context = `${provider} / ${modelId} / ${role}`;

          const effort = options.reasoning?.effort;
          if (effort !== undefined) {
            expect(declared, context).not.toBeNull();
            expect(declaredValues, context).toContain(effort);
          }

          const thinkingLevel = options.thinkingConfig?.thinkingLevel;
          if (thinkingLevel !== undefined) {
            expect(declaredValues, context).toContain(
              thinkingLevel.toLowerCase(),
            );
          }

          if (options.temperature !== undefined) {
            expect(shouldEmitTemperature(modelId), context).toBe(true);
          }
        }
      }
    }
  });

  test("sends no reasoning or sampling controls for models outside the catalog", () => {
    // Unknown IDs (env overrides, agent-chosen models — the explicit-id
    // path deliberately does not allowlist) have no declared
    // capability; the provider default is the only safe request. An
    // o-series id via the arbitrary path must not receive temperature.
    for (const provider of TANSTACK_AI_PROVIDERS) {
      if (provider === "google") {
        continue; // safetySettings are always sent; asserted below.
      }
      const options = looseOptions(
        tanStackModelOptionsForRole({
          role: "fast",
          provider,
          modelId: "totally-unknown-model",
          organizationId: null,
        }),
      );
      expect(options, provider).toEqual({});
    }
    const google = tanStackModelOptionsForRole({
      role: "fast",
      provider: "google",
      modelId: "totally-unknown-model",
      organizationId: null,
    });
    expect(looseOptions(google).temperature).toBeUndefined();
    expect(looseOptions(google).thinkingConfig).toBeUndefined();
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

  test("omits sampling for OpenAI reasoning models in non-reasoning roles", () => {
    // gpt-5.x reject any temperature but the default (a 400); a
    // catalogued effort ladder marks such a model, so no role may emit
    // `temperature` for it.
    const options = tanStackModelOptionsForRole({
      role: "chat",
      provider: "openai",
      modelId: "gpt-5.4",
      organizationId: null,
    });

    expect(options).not.toHaveProperty("temperature");
  });

  test("sends no sampling params for uncatalogued OpenAI models", () => {
    // Custom deployments / env overrides have no declared capability;
    // parameters are only sent on positive evidence the model accepts
    // them, so the provider default is the only safe request.
    const options = tanStackModelOptionsForRole({
      role: "chat",
      provider: "openai",
      modelId: "some-custom-openai-model",
      organizationId: null,
    });

    expect(options).toEqual({});
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
