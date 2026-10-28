import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import {
  BYOK_DEFAULT_MODELS,
  BYOK_DOCUMENT_INPUT_MODEL_OPTIONS,
  BYOK_MODEL_OPTIONS,
  CHAT_PDF_ATTACHMENT_MODEL_OPTIONS,
  getModelReasoningEfforts,
  isBYOKProviderRoleSupported,
  MODEL_TASK_OVERRIDE_GROUP,
  MODEL_TASKS,
  shouldEmitTemperature,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type { ModelOverrideGroup } from "@stll/ai-catalog";
import { MODEL_DEFAULTS_LEDGER } from "@stll/ai-catalog/model-defaults-ledger";
import { assertProperty } from "@stll/property-testing";

import { env } from "@/api/env";
import { resolveOrgAIModelForTask } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE } from "@/api/lib/ai-config-response";
import { toSafeId } from "@/api/lib/branded-types";
import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import { toDataUrl } from "@/api/lib/data-url";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { StellaOpenRouterTextAdapter } from "@/api/lib/stella-openrouter-text-adapter";
import type { TanStackModelOptions } from "@/api/lib/tanstack-ai-models";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { installScriptedProvider } from "@/api/tests/helpers/chat-scripted-provider";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

testState.setEnvIfAbsent("EMAIL_PROVIDER", "smtp");
testState.setEnvIfAbsent("GOTENBERG_PASSWORD", "gotenberg");
testState.setEnvIfAbsent("GOTENBERG_URL", "http://localhost:3003");
testState.setEnvIfAbsent("GOTENBERG_USERNAME", "gotenberg");
testState.setEnv("AI_PROVIDER", "openai");
testState.setEnvIfAbsent("OPENAI_API_KEY", "test-openai-instance-key");
testState.setEnvIfAbsent("OPENROUTER_API_KEY", "test-openrouter-instance-key");
testState.setEnvIfAbsent("BEDROCK_API_KEY", "test-bedrock-instance-key");
testState.setEnvIfAbsent("MISTRAL_API_KEY", "test-mistral-instance-key");
testState.setEnvIfAbsent("REDIS_URL", "redis://localhost:6379");
testState.setEnvIfAbsent("SMTP_HOST", "localhost");
testState.setEnvIfAbsent("SMTP_PORT", "1025");

testState.setConfig("AI_PROVIDER", "openai");
testState.setConfig("OPENAI_API_KEY", "test-openai-instance-key");
testState.setConfig("OPENROUTER_API_KEY", "test-openrouter-instance-key");
testState.setConfig("BEDROCK_API_KEY", "test-bedrock-instance-key");
testState.setConfig("MISTRAL_API_KEY", "test-mistral-instance-key");
// Importing the scripted provider registers the dev mock; these cases resolve
// real adapters unless one switches the mock on itself.
testState.setConfig("USE_MOCK_AI", false);

const {
  clearByokAdapterCache,
  getTanStackTextModelInfoForTask,
  getTanStackTextModelInfoById,
  getStructuredOutputFallbackModelId,
  isModelSelectionAvailableForTask,
  getTanStackTextModelById,
  getTanStackTextModelForTask,
  hasTanStackInstanceProvider,
  isAllowedBYOKModel,
  isAllowedBYOKModelForTask,
  isDeferredServiceTierAvailableForTask,
  isMockTextAdapter,
  isTanStackAIProviderSupported,
  mockAnswersForOrganization,
  modelAcceptsPdfDocumentInput,
  modelAcceptsStreamingToolUse,
  modelAcceptsTextualDocumentInput,
  requireTanStackAIAvailableForTask,
  resolveEffectiveServiceTierForProvider,
  resolveTanStackAIProviderSupport,
  tanStackModelOptionsForTask,
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
      isAllowedBYOKModelForTask({
        provider: "mistral",
        modelId: "mistral-large-latest",
        task: "chat",
      }),
    ).toBe(true);
    expect(
      isAllowedBYOKModelForTask({
        provider: "mistral",
        modelId: "mistral-large-latest",
        task: "pdf",
      }),
    ).toBe(false);
    expect(
      isAllowedBYOKModelForTask({
        provider: "openai",
        modelId: "gpt-5.4",
        task: "pdf",
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
  test.each(TANSTACK_AI_PROVIDERS)(
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
    // not a pdf-task provider, so textual documents must never route to it.
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

  test("reports deferred availability from the selected task provider", () => {
    expect(
      isDeferredServiceTierAvailableForTask(
        "chat",
        orgConfigForProvider("openrouter"),
      ),
    ).toBe(true);
    expect(
      isDeferredServiceTierAvailableForTask(
        "chat",
        orgConfigForProvider("anthropic"),
      ),
    ).toBe(false);
  });
});

describe("TanStack text model resolution", () => {
  test("reports an instance provider only when TanStack can serve it", () => {
    expect(hasTanStackInstanceProvider()).toBe(false);
    const previousProvider = env.AI_PROVIDER;
    testState.setConfig("AI_PROVIDER", "openrouter");
    try {
      expect(hasTanStackInstanceProvider()).toBe(true);
    } finally {
      testState.setConfig("AI_PROVIDER", previousProvider);
    }
  });

  test("checks the managed policy for ambient Bedrock credentials", () => {
    const originalEnv = {
      AI_PROVIDER: env.AI_PROVIDER,
      BEDROCK_API_KEY: env.BEDROCK_API_KEY,
    };
    const originalProcessBedrockApiKey = process.env["BEDROCK_API_KEY"];

    try {
      testState.setConfig("AI_PROVIDER", "bedrock");
      testState.setConfig("BEDROCK_API_KEY", undefined);
      testState.deleteEnv("BEDROCK_API_KEY");

      expect(() =>
        getTanStackTextModelForTask("chat", null, {
          dataClass: "customer",
          managedAIResidency: "eu",
          organizationId: orgId,
          modelTier: MANAGED_MODEL_TIER.standard,
        }),
      ).toThrow("Managed AI is not available");

      expect(hasTanStackInstanceProvider()).toBe(false);
    } finally {
      testState.patchConfig(originalEnv);
      if (originalProcessBedrockApiKey === undefined) {
        testState.deleteEnv("BEDROCK_API_KEY");
      } else {
        testState.setEnv("BEDROCK_API_KEY", originalProcessBedrockApiKey);
      }
    }
  });

  test("checks the managed policy for an automatically selected provider", () => {
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
      testState.setConfig("AI_PROVIDER", undefined);
      testState.setConfig("ANTHROPIC_API_KEY", undefined);
      testState.setConfig("BEDROCK_API_KEY", undefined);
      testState.setConfig("GOOGLE_GENERATIVE_AI_API_KEY", undefined);
      testState.setConfig("OPENAI_API_KEY", undefined);
      testState.setConfig("OPENROUTER_API_KEY", undefined);
      testState.setConfig("AZURE_API_KEY", "test-azure-key");
      testState.setConfig(
        "AZURE_BASE_URL",
        "https://example.openai.azure.com/openai",
      );
      testState.setConfig("HUGGINGFACE_API_KEY", "test-hf-key");
      testState.setConfig(
        "HUGGINGFACE_BASE_URL",
        "https://example.endpoints.huggingface.cloud/v1",
      );
      testState.setConfig("MISTRAL_API_KEY", "test-mistral-instance-key");

      expect(() =>
        getTanStackTextModelForTask("chat", null, {
          dataClass: "customer",
          managedAIResidency: "eu",
          organizationId: orgId,
          modelTier: MANAGED_MODEL_TIER.standard,
        }),
      ).toThrow('Managed AI is not available for provider "mistral"');

      expect(hasTanStackInstanceProvider()).toBe(false);
    } finally {
      testState.patchConfig(originalEnv);
    }
  });

  test("resolves customer OpenAI models through an arbitrary-id compatible adapter", () => {
    const model = getTanStackTextModelById(
      "openai::gpt-5.4",
      orgConfigForProvider("openai"),
      {
        task: "reasoning",
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
        modelTier: MANAGED_MODEL_TIER.standard,
      },
    );

    expect(model).toMatchObject({
      keySource: "byok",
      provider: "openai",
      modelId: "gpt-5.4",
    });
    expect(model.adapter.name).toBe("openai");
    expect(model.adapter.model).toBe("gpt-5.4");
    expect(looseOptions(model.modelOptions)).toEqual<unknown>({
      reasoning: { effort: "medium" },
      include: ["reasoning.encrypted_content"],
      store: false,
    });
  });

  test("refuses instance-key dispatch of a model with no published rate", () => {
    expect(() =>
      getTanStackTextModelById("openai::gpt-unrated-experiment", null, {
        task: "chat",
        dataClass: "public_corpus",
        organizationId: orgId,
        modelTier: MANAGED_MODEL_TIER.standard,
      }),
    ).toThrow(
      'Model "gpt-unrated-experiment" is not available on this deployment.',
    );
  });

  test("routes provider-qualified explicit ids through configured OpenRouter credentials", () => {
    const model = getTanStackTextModelById(
      "openrouter::google/gemini-3.5-flash",
      null,
      {
        task: "chat",
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: null,
        modelTier: MANAGED_MODEL_TIER.standard,
      },
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
    testState.setConfig("GOOGLE_GENERATIVE_AI_API_KEY", "test-google-key");
    try {
      const model = getTanStackTextModelById(
        "google::gemini-3.6-flash",
        orgConfigForProvider("google"),
        {
          task: "chat",
          dataClass: "customer",
          managedAIResidency: "eu",
          organizationId: null,
          modelTier: MANAGED_MODEL_TIER.standard,
        },
      );

      expect(looseOptions(model.modelOptions).thinkingConfig).toBeUndefined();
    } finally {
      testState.setConfig("GOOGLE_GENERATIVE_AI_API_KEY", originalKey);
    }
  });

  test("resolves Mistral BYOK selections through the TanStack adapter", () => {
    const orgConfig = orgConfigForProvider("mistral");

    const model = getTanStackTextModelForTask("chat", orgConfig, {
      dataClass: "customer",
      managedAIResidency: "eu",
      organizationId: orgId,
      modelTier: MANAGED_MODEL_TIER.standard,
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
      getTanStackTextModelForTask("pdf", orgConfigForProvider("mistral"), {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
        modelTier: MANAGED_MODEL_TIER.standard,
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

    const unavailable = requireTanStackAIAvailableForTask({
      configStatus: ORG_AI_CONFIG_STATUS.ok,
      dataClass: "customer",
      orgConfig,
      task: "pdf",
    });

    expect(unavailable.isErr()).toBe(true);
    if (unavailable.isErr()) {
      expect(unavailable.error.status).toBe(400);
      expect(unavailable.error.message).toContain("document input");
    }

    let handlerError: unknown;
    try {
      getTanStackTextModelForTask("pdf", orgConfig, {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
        modelTier: MANAGED_MODEL_TIER.standard,
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

  test.each(["customer", "public_corpus"] as const)(
    "rejects unavailable instance requests for %s in task availability preflight",
    (dataClass) => {
      const originalProvider = env.AI_PROVIDER;
      try {
        testState.setConfig("AI_PROVIDER", "mistral");

        const unavailable = requireTanStackAIAvailableForTask({
          configStatus: ORG_AI_CONFIG_STATUS.ok,
          dataClass,
          orgConfig: null,
          task: "pdf",
        });

        expect(unavailable.isErr()).toBe(true);
        if (unavailable.isErr()) {
          if (dataClass === "customer") {
            expect(unavailable.error.status).toBe(503);
            expect(unavailable.error.code).toBe(
              MANAGED_PROVIDER_UNAVAILABLE_CODE,
            );
          } else {
            expect(unavailable.error.status).toBe(400);
            expect(unavailable.error.message).toContain("PDF flows");
          }
        }
      } finally {
        testState.setConfig("AI_PROVIDER", originalProvider);
      }
    },
  );

  test("keeps streaming structured output for a Bedrock model with streaming tool use", () => {
    const orgConfig = orgConfigForProvider("bedrock");
    orgConfig.overrideModels.chat = {
      provider: "bedrock",
      modelId: "us.amazon.nova-lite-v1:0",
    };

    const model = getTanStackTextModelForTask("chat", orgConfig, {
      dataClass: "customer",
      managedAIResidency: "eu",
      organizationId: orgId,
      modelTier: MANAGED_MODEL_TIER.standard,
    });

    expect(modelAcceptsStreamingToolUse(model)).toBe(true);
    expect(model.adapter.structuredOutputStream).toBeDefined();
  });

  test("resolves Bedrock BYOK selections through the TanStack adapter", () => {
    const orgConfig = orgConfigForProvider("bedrock");

    const model = getTanStackTextModelForTask("chat", orgConfig, {
      dataClass: "customer",
      managedAIResidency: "eu",
      organizationId: orgId,
      modelTier: MANAGED_MODEL_TIER.standard,
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

  test.each(["within-limit", "oversized"] as const)(
    "sends a Bedrock model a valid %s image within provider limits",
    async (size) => {
      const orgConfig = orgConfigForProvider("bedrock");
      orgConfig.overrideModels.chat = {
        provider: "bedrock",
        modelId: "us.amazon.nova-lite-v1:0",
      };
      const model = getTanStackTextModelForTask("chat", orgConfig, {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
        modelTier: MANAGED_MODEL_TIER.standard,
      });
      const validPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/ltyVPwAAAABJRU5ErkJggg==",
        "base64",
      );
      const png =
        size === "oversized"
          ? Buffer.concat([
              validPng,
              Buffer.alloc(3_750_001 - validPng.byteLength),
            ])
          : validPng;
      expect(png.byteLength > 3_750_000).toBe(size === "oversized");
      const bodies: unknown[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: RequestInit,
        ): Promise<Response> => {
          const request =
            input instanceof Request
              ? input
              : new Request(input.toString(), init);
          bodies.push(await request.clone().json());
          return new Response(JSON.stringify({ message: "stop" }), {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-amzn-errortype": "ValidationException",
            },
          });
        },
        { preconnect: originalFetch.preconnect },
      );
      try {
        for await (const _chunk of model.adapter.chatStream({
          threadId: Bun.randomUUIDv7(),
          logger: resolveDebugOption(false),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", content: "Describe the attached image." },
                {
                  type: "image",
                  // How a chat attachment reaches the model.
                  source: {
                    type: "url",
                    value: toDataUrl(png, "image/png"),
                    mimeType: "image/png",
                  },
                },
              ],
            },
          ],
          model: model.modelId,
        })) {
          // The refusal ends the stream once the request is written.
        }
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(bodies).toHaveLength(1);
      expect(bodies.at(0)).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { text: "Describe the attached image." },
              {
                image: {
                  format: size === "oversized" ? "webp" : "png",
                  source: {
                    bytes:
                      size === "oversized"
                        ? expect.any(String)
                        : Buffer.from(png).toBase64(),
                  },
                },
              },
            ],
          },
        ],
      });
    },
  );

  test.each([
    "us.amazon.nova-micro-v1:0",
    "openai.gpt-oss-120b-1:0",
    "openai.gpt-oss-20b-1:0",
  ])(
    "refuses images for text-only Bedrock model %s before fetch",
    async (modelId) => {
      const orgConfig = orgConfigForProvider("bedrock");
      orgConfig.overrideModels.chat = { provider: "bedrock", modelId };
      const model = getTanStackTextModelForTask("chat", orgConfig, {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
        modelTier: MANAGED_MODEL_TIER.standard,
      });
      let fetchCalls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ message: "stop" }), {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-amzn-errortype": "ValidationException",
            },
          });
        },
        { preconnect: originalFetch.preconnect },
      );
      try {
        const chunks = [];
        for await (const chunk of model.adapter.chatStream({
          threadId: Bun.randomUUIDv7(),
          logger: resolveDebugOption(false),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "url",
                    value:
                      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/ltyVPwAAAABJRU5ErkJggg==",
                    mimeType: "image/png",
                  },
                },
              ],
            },
          ],
          model: model.modelId,
        })) {
          chunks.push(chunk);
        }
        expect(chunks).toMatchObject([
          {
            type: "RUN_ERROR",
            code: "image_input_unsupported",
            error: { code: "image_input_unsupported" },
          },
        ]);
        expect(fetchCalls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  test("normalizes existing Google regional BYOK selections to global", () => {
    const orgConfig = orgConfigForProvider("google", "eu");

    const model = getTanStackTextModelForTask("chat", orgConfig, {
      dataClass: "customer",
      managedAIResidency: "eu",
      organizationId: orgId,
      modelTier: MANAGED_MODEL_TIER.standard,
    });

    expect(model).toMatchObject({
      keySource: "byok",
      provider: "google",
      region: "global",
    });
    expect(model.adapter.name).toBe("gemini");
  });

  test("reports TanStack availability per selected task", () => {
    expect(
      requireTanStackAIAvailableForTask({
        configStatus: ORG_AI_CONFIG_STATUS.ok,
        dataClass: "customer",
        orgConfig: orgConfigForProvider("openai"),
        task: "chat",
      }).isOk(),
    ).toBe(true);

    const unavailable = requireTanStackAIAvailableForTask({
      configStatus: ORG_AI_CONFIG_STATUS.ok,
      dataClass: "customer",
      orgConfig: orgConfigForProvider("openai_compatible"),
      task: "chat",
    });

    expect(unavailable.isErr()).toBe(true);
    if (unavailable.isErr()) {
      expect(unavailable.error.status).toBe(400);
      expect(unavailable.error.message).toContain("OpenAI-compatible");
    }

    const unsupportedRole = requireTanStackAIAvailableForTask({
      configStatus: ORG_AI_CONFIG_STATUS.ok,
      dataClass: "customer",
      orgConfig: orgConfigForProvider("mistral"),
      task: "pdf",
    });

    expect(unsupportedRole.isErr()).toBe(true);
    if (unsupportedRole.isErr()) {
      expect(unsupportedRole.error.status).toBe(400);
      expect(unsupportedRole.error.message).toContain("PDF flows");
    }
  });

  test("a null organization config reaches the instance provider only with an ok status", () => {
    // A stored config that failed to decrypt, or an organization barred from
    // the instance provider, must not fall back to the shared instance
    // provider, which would route the call somewhere the organization never
    // configured.
    const refusalStatus = {
      ok: null,
      unreadable: 503,
      own_key_required: 403,
      member_assignment_required: 403,
    } as const satisfies Record<OrgAIConfigStatus, number | null>;

    for (const configStatus of Object.values(ORG_AI_CONFIG_STATUS)) {
      const status = refusalStatus[configStatus];
      if (status === null) {
        continue;
      }
      const refused = requireTanStackAIAvailableForTask({
        configStatus,
        dataClass: "customer",
        orgConfig: null,
        task: "chat",
      });

      expect(refused.isErr()).toBe(true);
      if (refused.isErr()) {
        expect(refused.error.status).toBe(status);
      }
    }
  });

  test("refuses a member without a seat assignment on the organization's own key", () => {
    const refused = requireTanStackAIAvailableForTask({
      configStatus: ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      dataClass: "customer",
      orgConfig: orgConfigForProvider("openrouter"),
      task: "chat",
    });

    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) {
      expect(refused.error.status).toBe(403);
      expect(refused.error.code).toBe(AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE);
    }
  });

  test("exposes TanStack model metadata without leaking the adapter", () => {
    const modelInfo = getTanStackTextModelInfoForTask(
      "chat",
      orgConfigForProvider("openrouter"),
      {
        dataClass: "customer",
        organizationId: orgId,
        modelTier: MANAGED_MODEL_TIER.standard,
      },
    );

    expect(modelInfo).toEqual({
      availability: "available",
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

describe("tanStackModelOptionsForTask", () => {
  test("every task default preserves the emitted provider request baseline", () => {
    const safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_ONLY_HIGH",
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_ONLY_HIGH",
      },
    ];
    // These are the pre-ledger wire options; Haiku's provider defaults omit
    // temperature, the sole sampling change accompanying its model cutover.
    const baseline = {
      google: {
        routine: {
          safetySettings,
          thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false },
        },
        reasoning: {
          safetySettings,
          thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: false },
        },
        fast: {
          safetySettings,
          thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false },
        },
      },
      anthropic: {
        routine: {},
        reasoning: { thinking: { type: "adaptive" } },
        fast: {},
      },
      bedrock: {
        routine: { temperature: 0 },
        reasoning: { temperature: 0 },
        fast: {},
      },
      mistral: {
        routine: { temperature: 0 },
        reasoning: { temperature: 0 },
        fast: { temperature: 0 },
      },
      openai: {
        routine: { include: ["reasoning.encrypted_content"], store: false },
        reasoning: {
          include: ["reasoning.encrypted_content"],
          store: false,
          reasoning: { effort: "medium" },
        },
        fast: { include: ["reasoning.encrypted_content"], store: false },
      },
      openrouter: {
        routine: {},
        reasoning: { reasoning: { effort: "high" } },
        fast: { reasoning: { effort: "none" } },
      },
    } satisfies Record<
      (typeof TANSTACK_AI_PROVIDERS)[number],
      { routine: unknown; reasoning: unknown; fast: unknown }
    >;
    const modeByGroup = {
      fast: "fast",
      chat: "routine",
      reasoning: "reasoning",
      pdf: "routine",
    } as const satisfies Record<
      ModelOverrideGroup,
      keyof typeof baseline.google
    >;
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const task of MODEL_TASKS) {
        const entry = MODEL_DEFAULTS_LEDGER[task][provider];
        if (entry.kind === "unsupported") {
          continue;
        }
        const mode = modeByGroup[MODEL_TASK_OVERRIDE_GROUP[task]];
        // Resolved options carry brands; the baseline states plain values.
        const options: unknown = tanStackModelOptionsForTask({
          provider,
          task,
          modelId: entry.candidate.modelId,
          organizationId: null,
        });
        expect(
          options,
          `${provider}/${task}/${entry.candidate.modelId}`,
        ).toEqual(baseline[provider][mode]);
      }
    }
  });

  test("keeps deterministic sampling for OpenRouter", () => {
    expect(
      tanStackModelOptionsForTask({
        task: "chat",
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
      const options = tanStackModelOptionsForTask({
        task: "chat",
        organizationId: null,
        ...candidate,
      });
      expect(
        options,
        `${candidate.provider}/${candidate.modelId}`,
      ).not.toHaveProperty("temperature");
    }
  });

  test("clamps the fast-task effort into the model's declared capability", () => {
    // gemini-3.5-flash cannot disable reasoning ("Reasoning is
    // mandatory" 502 class): the fast task's "none" request must
    // degrade to the model's weakest declared tier.
    expect(
      looseOptions(
        tanStackModelOptionsForTask({
          task: "short-text",
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
      tanStackModelOptionsForTask({
        task: "short-text",
        provider: "openrouter",
        modelId: "openai/gpt-5.4-mini",
        organizationId: null,
      }),
    );
    expect(gptOptions).toMatchObject({ reasoning: { effort: "none" } });
    expect(gptOptions.temperature).toBeUndefined();
  });

  test("preserves OpenRouter reasoning-task effort on capable models", () => {
    expect(
      looseOptions(
        tanStackModelOptionsForTask({
          task: "reasoning",
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
        tanStackModelOptionsForTask({
          task: "chat",
          provider: "google",
          modelId: "gemini-3.6-flash",
          organizationId: null,
          reasoningEffort: "medium",
        }),
      ),
    ).toMatchObject({ thinkingConfig: { thinkingLevel: "MEDIUM" } });
    expect(
      tanStackModelOptionsForTask({
        task: "chat",
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
      tanStackModelOptionsForTask({
        task: "chat",
        provider: "openai",
        modelId: "gpt-5.5",
        organizationId: null,
        reasoningEffort: "xhigh",
      }),
    ).toMatchObject({ reasoning: { effort: "xhigh" } });
    expect(
      looseOptions(
        tanStackModelOptionsForTask({
          task: "chat",
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
      tanStackModelOptionsForTask({
        task: "chat",
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        organizationId: null,
        reasoningEffort: "none",
      }),
    ).toEqual({ thinking: { type: "disabled" } });
  });

  test("rejects an explicitly unsupported provider task before building options", () => {
    expect(() =>
      tanStackModelOptionsForTask({
        provider: "mistral",
        task: "pdf",
        modelId: "mistral-medium-latest",
        organizationId: null,
      }),
    ).toThrow("Unsupported Mistral task mode");
  });

  test("never emits a reasoning control outside the model's declared capability", () => {
    // The whole-class invariant behind the "Reasoning is mandatory"
    // 502: for EVERY offered model and task, any effort (or Gemini
    // thinking level) the builders emit must be in the model's
    // declared capability set, and models without one get nothing.
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        for (const task of MODEL_TASKS) {
          if (MODEL_DEFAULTS_LEDGER[task][provider].kind === "unsupported") {
            continue;
          }
          const options = looseOptions(
            tanStackModelOptionsForTask({
              task,
              provider,
              modelId,
              organizationId: null,
            }),
          );
          const declared = getModelReasoningEfforts(modelId);
          const declaredValues: readonly string[] = declared ?? [];
          const context = `${provider} / ${modelId} / ${task}`;

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
        tanStackModelOptionsForTask({
          task: "short-text",
          provider,
          modelId: "totally-unknown-model",
          organizationId: null,
        }),
      );
      expect(options, provider).toEqual<unknown>(
        provider === "openai" ? { include: [] } : {},
      );
    }
    const google = tanStackModelOptionsForTask({
      task: "short-text",
      provider: "google",
      modelId: "totally-unknown-model",
      organizationId: null,
    });
    expect(looseOptions(google).temperature).toBeUndefined();
    expect(looseOptions(google).thinkingConfig).toBeUndefined();
  });

  test("every OpenAI reasoning model requests stateless replay data in every task", () => {
    for (const modelId of BYOK_MODEL_OPTIONS.openai) {
      for (const task of MODEL_TASKS) {
        const options = tanStackModelOptionsForTask({
          provider: "openai",
          modelId,
          task,
          organizationId: null,
        });
        expect(options, `${modelId}/${task}`).toMatchObject({
          include: ["reasoning.encrypted_content"],
          store: false,
        });
      }
    }
  });

  test("uses TanStack Anthropic snake_case thinking options", () => {
    expect(
      tanStackModelOptionsForTask({
        task: "reasoning",
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
      tanStackModelOptionsForTask({
        task: "reasoning",
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

  test("constructs Haiku 5.5 reasoning requests with adaptive thinking and no sampling", () => {
    const options = tanStackModelOptionsForTask({
      task: "reasoning",
      provider: "anthropic",
      modelId: "claude-haiku-5-5",
      organizationId: orgId,
      reasoningEffort: "high",
    });
    expect(options).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("topP");
    expect(options).not.toHaveProperty("topK");
  });

  test("does not emit unsupported Anthropic user metadata", () => {
    const options = tanStackModelOptionsForTask({
      task: "chat",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      organizationId: orgId,
    });

    expect(options).not.toHaveProperty("user_id");
  });

  test("omits sampling for Anthropic fixed-sampling models", () => {
    const options = tanStackModelOptionsForTask({
      task: "chat",
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      organizationId: null,
    });

    expect(options).not.toHaveProperty("temperature");
  });

  test("omits sampling for OpenAI reasoning models in non-reasoning roles", () => {
    // Models whose catalogued temperature policy is "omit" reject any
    // temperature but the default (a 400), so no task may emit
    // `temperature` for them.
    const options = tanStackModelOptionsForTask({
      task: "chat",
      provider: "openai",
      modelId: "gpt-5.5",
      organizationId: null,
    });

    expect(options).not.toHaveProperty("temperature");
  });

  test("sends no sampling params for uncatalogued OpenAI models", () => {
    // Custom deployments / env overrides have no declared capability;
    // parameters are only sent on positive evidence the model accepts
    // them, so the provider default is the only safe request.
    const options = tanStackModelOptionsForTask({
      task: "chat",
      provider: "openai",
      modelId: "some-custom-openai-model",
      organizationId: null,
    });

    expect(options).toEqual({ include: [] });
  });
});

describe("who answers while the local mock is on", () => {
  // The scripted provider registers through the mock seam and switches it on;
  // each case then picks the mock mode it exercises.
  const answeredBy = ({
    mode,
    orgConfig,
  }: {
    mode: boolean | "force";
    orgConfig: OrgAIConfig | null;
  }) => {
    // Capture the mode before the provider helper changes it.
    testState.setConfig("USE_MOCK_AI", env.USE_MOCK_AI);
    const provider = installScriptedProvider();
    testState.setConfig("USE_MOCK_AI", mode);
    // A factory an earlier case cached must not answer for this one.
    clearByokAdapterCache();
    try {
      const model = getTanStackTextModelForTask("chat", orgConfig, {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
        modelTier: MANAGED_MODEL_TIER.standard,
      });
      return {
        adapter: isMockTextAdapter(model.adapter) ? "mock" : model.adapter.name,
        keySource: model.keySource,
        organizationMocked: mockAnswersForOrganization(orgConfig),
      };
    } finally {
      provider.restore();
    }
  };

  test("an organization key answers for real instead of the mock", () => {
    expect(
      answeredBy({ mode: true, orgConfig: orgConfigForProvider("mistral") }),
    ).toEqual({
      adapter: "mistral",
      keySource: "byok",
      organizationMocked: false,
    });
  });

  test("the mock answers where no organization key is configured", () => {
    expect(answeredBy({ mode: true, orgConfig: null })).toEqual({
      adapter: "mock",
      keySource: "instance",
      organizationMocked: true,
    });
  });

  test("force keeps an organization key on the mock", () => {
    expect(
      answeredBy({ mode: "force", orgConfig: orgConfigForProvider("mistral") }),
    ).toEqual({
      adapter: "mock",
      keySource: "byok",
      organizationMocked: true,
    });
  });

  test("reports no mock where dispatch refuses the deployment's provider", () => {
    // Capture the mode before the provider helper changes it.
    testState.setConfig("USE_MOCK_AI", env.USE_MOCK_AI);
    const provider = installScriptedProvider();
    const requirePersonalKey = env.REQUIRE_PERSONAL_AI_KEY;
    testState.setConfig("USE_MOCK_AI", true);
    testState.setConfig("REQUIRE_PERSONAL_AI_KEY", true);
    try {
      expect(mockAnswersForOrganization(null)).toBe(false);
      expect(() =>
        getTanStackTextModelForTask("chat", null, {
          dataClass: "customer",
          managedAIResidency: "eu",
          organizationId: orgId,
          modelTier: MANAGED_MODEL_TIER.standard,
        }),
      ).toThrow(HandlerError);
    } finally {
      testState.setConfig("REQUIRE_PERSONAL_AI_KEY", requirePersonalKey);
      provider.restore();
    }
  });

  test("with the mock off, an organization key answers for real", () => {
    expect(
      answeredBy({ mode: false, orgConfig: orgConfigForProvider("mistral") }),
    ).toEqual({
      adapter: "mistral",
      keySource: "byok",
      organizationMocked: false,
    });
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
) =>
  ({
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
    decision: null,
  }) satisfies OrgAIConfig;

describe("Anthropic workspace dispatch", () => {
  test("every model task receives workspace headers and changed workspace invalidates the cached factory", async () => {
    const requests: Headers[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (
          _url: Parameters<typeof globalThis.fetch>[0],
          init?: RequestInit,
        ) => {
          requests.push(new Headers(init?.headers));
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "Recorded transport stop",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    clearByokAdapterCache();
    try {
      for (const anthropicWorkspaceId of ["wrk_first", "wrk_second"]) {
        const defaults = BYOK_DEFAULT_MODELS.anthropic;
        const config = {
          providers: [
            {
              provider: "anthropic",
              apiKey: "sk-ant-usr-fixture",
              anthropicWorkspaceId,
            },
          ],
          overrideModels: {
            fast: { provider: "anthropic", modelId: defaults.fast.modelId },
            chat: { provider: "anthropic", modelId: defaults.chat.modelId },
            reasoning: {
              provider: "anthropic",
              modelId: defaults.reasoning.modelId,
            },
            pdf: { provider: "anthropic", modelId: defaults.pdf.modelId },
          },
          decision: null,
        } satisfies OrgAIConfig;
        for (const task of MODEL_TASKS) {
          const model = getTanStackTextModelForTask(task, config, {
            organizationId: orgId,
            dataClass: "customer",
            managedAIResidency: "eu",
            modelTier: MANAGED_MODEL_TIER.standard,
          });
          const before = requests.length;
          for await (const _chunk of model.adapter.chatStream({
            threadId: Bun.randomUUIDv7(),
            logger: resolveDebugOption(false),
            messages: [{ role: "user", content: "Fixture" }],
            model: model.adapter.model,
          })) {
            // Recorded response exercises serialization without calling a provider.
          }
          expect(requests).toHaveLength(before + 1);
          expect(requests.at(-1)?.get("anthropic-workspace-id")).toBe(
            anthropicWorkspaceId,
          );
        }
      }
    } finally {
      fetchSpy.mockRestore();
      clearByokAdapterCache();
    }
  });
});

test("unoverridden organization roles dispatch the catalog default with truthful task availability", () => {
  for (const provider of TANSTACK_AI_PROVIDERS) {
    const config = {
      providers: [{ provider, apiKey: "fixture-key" }],
      overrideModels: null,
      decision: null,
    } satisfies OrgAIConfig;
    for (const task of MODEL_TASKS) {
      const supported = isBYOKProviderRoleSupported({
        provider,
        role: MODEL_TASK_OVERRIDE_GROUP[task],
      });
      const available = requireTanStackAIAvailableForTask({
        configStatus: ORG_AI_CONFIG_STATUS.ok,
        dataClass: "customer",
        orgConfig: config,
        task,
      });
      expect(available.isOk()).toBe(supported);
      const entry = MODEL_DEFAULTS_LEDGER[task][provider];
      if (entry.kind === "unsupported") {
        continue;
      }
      expect(
        getTanStackTextModelInfoForTask(task, config, {
          dataClass: "customer",
          organizationId: orgId,
          modelTier: MANAGED_MODEL_TIER.standard,
        }),
      ).toMatchObject({
        provider,
        modelId: entry.candidate.modelId,
        keySource: "byok",
      });
    }
  }
});

describe("managed model tier", () => {
  const MANAGED_CUSTOMER = {
    dataClass: "customer",
    managedAIResidency: "eu",
    organizationId: orgId,
  } as const;
  // The organization's own key: each task on its own catalog model, so a
  // task served by the wrong model shows.
  const OWN_KEY_CONFIG = {
    providers: [{ provider: "openai", apiKey: "test-org-provider-key" }],
    overrideModels: {
      fast: {
        provider: "openai",
        modelId: BYOK_DEFAULT_MODELS.openai.fast.modelId,
      },
      chat: {
        provider: "openai",
        modelId: BYOK_DEFAULT_MODELS.openai.chat.modelId,
      },
      reasoning: {
        provider: "openai",
        modelId: BYOK_DEFAULT_MODELS.openai.reasoning.modelId,
      },
      pdf: {
        provider: "openai",
        modelId: BYOK_DEFAULT_MODELS.openai.pdf.modelId,
      },
    },
    decision: null,
  } satisfies OrgAIConfig;

  const withManagedOpenRouter = (run: () => void) => {
    const originalProvider = env.AI_PROVIDER;
    testState.setConfig("AI_PROVIDER", "openrouter");
    try {
      run();
    } finally {
      testState.setConfig("AI_PROVIDER", originalProvider);
    }
  };

  test("the fast tier serves every catalog task on the managed fast model", () => {
    withManagedOpenRouter(() => {
      const fastModelId =
        MODEL_DEFAULTS_LEDGER["short-text"].openrouter.candidate.modelId;
      // The standard tier keeps per-task models, so the fast tier is visible.
      expect(
        MODEL_TASKS.some(
          (task) =>
            MODEL_DEFAULTS_LEDGER[task].openrouter.candidate.modelId !==
            fastModelId,
        ),
      ).toBe(true);
      for (const task of MODEL_TASKS) {
        expect(
          getTanStackTextModelForTask(task, null, {
            ...MANAGED_CUSTOMER,
            modelTier: MANAGED_MODEL_TIER.fast,
          }),
        ).toMatchObject({
          keySource: "instance",
          provider: "openrouter",
          modelId: fastModelId,
        });
        expect(
          getTanStackTextModelForTask(task, null, {
            ...MANAGED_CUSTOMER,
            modelTier: MANAGED_MODEL_TIER.standard,
          }).modelId,
        ).toBe(MODEL_DEFAULTS_LEDGER[task].openrouter.candidate.modelId);
      }
    });
  });

  test("the fast tier serves a managed per-turn selection on the fast model", () => {
    withManagedOpenRouter(() => {
      const selection = `openrouter::${MODEL_DEFAULTS_LEDGER.chat.openrouter.candidate.modelId}`;
      expect(
        getTanStackTextModelById(selection, null, {
          ...MANAGED_CUSTOMER,
          task: "chat",
          modelTier: MANAGED_MODEL_TIER.fast,
        }).modelId,
      ).toBe(MODEL_DEFAULTS_LEDGER["short-text"].openrouter.candidate.modelId);
      expect(
        getTanStackTextModelById(selection, null, {
          ...MANAGED_CUSTOMER,
          task: "chat",
          modelTier: MANAGED_MODEL_TIER.standard,
        }).modelId,
      ).toBe(MODEL_DEFAULTS_LEDGER.chat.openrouter.candidate.modelId);
    });
  });

  test("a task resolves its tier's managed model, or the organization's own model under its key", () => {
    withManagedOpenRouter(() => {
      assertProperty(
        "a task resolves its tier's managed model, or the organization's own model under its key",
        fc.property(
          fc.constantFrom(...MODEL_TASKS),
          fc.constantFrom(...Object.values(MANAGED_MODEL_TIER)),
          fc.constantFrom("managed", "own_key"),
          fc.option(fc.constantFrom(...MODEL_TASKS), { nil: undefined }),
          (task, modelTier, credentials, selectedRole) => {
            const orgConfig = credentials === "own_key" ? OWN_KEY_CONFIG : null;
            const ownKey = credentials === "own_key";
            let selectedModelId: string | undefined;
            if (selectedRole !== undefined) {
              selectedModelId = ownKey
                ? OWN_KEY_CONFIG.overrideModels[
                    MODEL_TASK_OVERRIDE_GROUP[selectedRole]
                  ].modelId
                : `openrouter::${MODEL_DEFAULTS_LEDGER[selectedRole].openrouter.candidate.modelId}`;
            }
            // Oracle: the own key serves what the organization configured or
            // selected; the fast tier serves the fast model; the standard
            // tier serves the selection, else the task's model.
            const managedModelId =
              modelTier === MANAGED_MODEL_TIER.fast
                ? MODEL_DEFAULTS_LEDGER["short-text"].openrouter.candidate
                    .modelId
                : MODEL_DEFAULTS_LEDGER[selectedRole ?? task].openrouter
                    .candidate.modelId;
            const expectedModelId = ownKey
              ? (selectedModelId ??
                OWN_KEY_CONFIG.overrideModels[MODEL_TASK_OVERRIDE_GROUP[task]]
                  .modelId)
              : managedModelId;
            const dispatched =
              selectedModelId === undefined
                ? getTanStackTextModelForTask(task, orgConfig, {
                    ...MANAGED_CUSTOMER,
                    modelTier,
                  })
                : getTanStackTextModelById(selectedModelId, orgConfig, {
                    ...MANAGED_CUSTOMER,
                    task,
                    modelTier,
                  });
            expect(dispatched.modelId).toBe(expectedModelId);
            expect(dispatched.keySource).toBe(
              credentials === "own_key" ? "byok" : "instance",
            );
            // Metering and analytics resolve the model dispatch serves.
            const info =
              selectedModelId === undefined
                ? getTanStackTextModelInfoForTask(task, orgConfig, {
                    dataClass: "customer",
                    organizationId: orgId,
                    modelTier,
                  })
                : getTanStackTextModelInfoById(
                    selectedModelId,
                    orgConfig,
                    task,
                    { dataClass: "customer", modelTier },
                  );
            expect(info).toMatchObject({
              modelId: dispatched.modelId,
              keySource: dispatched.keySource,
              provider: dispatched.provider,
            });
          },
        ),
      );
    });
  });
});

describe("approved structured-output fallback selection", () => {
  test("structured fallback stays within configured task models", () => {
    assertProperty(
      "structured fallback stays within configured task models",
      fc.property(
        fc.subarray([...TANSTACK_AI_PROVIDERS]),
        fc.constantFrom(...MODEL_TASKS),
        fc.constantFrom(...Object.values(BYOK_MODEL_OPTIONS).flat()),
        (providers, task, failedModelId) => {
          const orgAIConfig = {
            providers: providers.map((provider) => ({
              provider,
              apiKey: "test-org-provider-key",
            })),
            overrideModels: null,
            decision: null,
          } satisfies OrgAIConfig;
          const options = {
            failedModelId,
            orgAIConfig,
            task,
            modelTier: MANAGED_MODEL_TIER.standard,
            dataClass: "customer",
            managedAIResidency: "eu",
          } as const;
          const fallback = getStructuredOutputFallbackModelId(options);
          const assignedProvider = resolveOrgAIModelForTask(
            orgAIConfig,
            task,
          )?.provider;
          const availableModels = providers.flatMap((provider) => {
            const models: readonly string[] = BYOK_MODEL_OPTIONS[provider];
            return models.filter(
              (modelId) =>
                provider === assignedProvider &&
                modelId !== failedModelId &&
                isAllowedBYOKModelForTask({ provider, modelId, task }),
            );
          });
          if (fallback === null) {
            expect(availableModels).toHaveLength(0);
            return;
          }
          const [provider, ...modelParts] = fallback.split("::");
          const modelId = modelParts.join("::");
          expect(providers.some((configured) => configured === provider)).toBe(
            true,
          );
          expect(provider).toBe(assignedProvider);
          expect(availableModels).toContain(modelId);
          expect(modelId).not.toBe(failedModelId);
          expect(getStructuredOutputFallbackModelId(options)).toBe(fallback);
        },
      ),
    );
  });

  test("spare providers cannot override an explicit task assignment", () => {
    for (const provider of ["openai", "google"] as const) {
      const failedModelId = BYOK_DEFAULT_MODELS[provider].chat.modelId;
      const fallback = getStructuredOutputFallbackModelId({
        failedModelId,
        orgAIConfig: {
          providers: [
            { provider: "google", apiKey: "fixture-google-key" },
            { provider: "openai", apiKey: "fixture-openai-key" },
          ],
          overrideModels: { chat: { provider, modelId: failedModelId } },
          decision: null,
        },
        task: "chat",
        modelTier: MANAGED_MODEL_TIER.standard,
        dataClass: "customer",
        managedAIResidency: "eu",
      });
      expect(fallback).toStartWith(`${provider}::`);
      expect(fallback).not.toBe(`${provider}::${failedModelId}`);
    }
  });

  test("an organization without an approved provider skips fallback", () => {
    expect(
      getStructuredOutputFallbackModelId({
        failedModelId: MODEL_DEFAULTS_LEDGER.chat.openai.candidate.modelId,
        orgAIConfig: { providers: [], overrideModels: null, decision: null },
        task: "chat",
        modelTier: MANAGED_MODEL_TIER.standard,
        dataClass: "customer",
        managedAIResidency: "eu",
      }),
    ).toBeNull();
  });

  test("a configured provider without approved models for the task skips fallback", () => {
    const orgAIConfig = orgConfigForProvider("mistral");
    expect(
      BYOK_MODEL_OPTIONS.mistral.every(
        (modelId) =>
          !isAllowedBYOKModelForTask({
            provider: "mistral",
            modelId,
            task: "pdf",
          }),
      ),
    ).toBe(true);
    expect(
      getStructuredOutputFallbackModelId({
        failedModelId: MODEL_DEFAULTS_LEDGER.chat.mistral.candidate.modelId,
        orgAIConfig,
        task: "pdf",
        modelTier: MANAGED_MODEL_TIER.standard,
        dataClass: "customer",
        managedAIResidency: "eu",
      }),
    ).toBeNull();
  });

  test("managed fallback distinguishes public corpus from customer data", () => {
    testState.setConfig("AI_PROVIDER", "openai");
    testState.setConfig("OPENAI_API_KEY", "test-openai-instance-key");
    testState.setConfig("REQUIRE_PERSONAL_AI_KEY", false);
    testState.setConfig("USE_MOCK_AI", false);
    expect(
      isModelSelectionAvailableForTask({
        dataClass: "public_corpus",
        provider: "openai",
        modelId: MODEL_DEFAULTS_LEDGER.chat.openai.candidate.modelId,
        orgAIConfig: null,
        task: "chat",
      }),
    ).toBe(true);
    const publicFallback = getStructuredOutputFallbackModelId({
      failedModelId: MODEL_DEFAULTS_LEDGER.chat.openai.candidate.modelId,
      orgAIConfig: null,
      task: "chat",
      modelTier: MANAGED_MODEL_TIER.standard,
      dataClass: "public_corpus",
    });
    expect(publicFallback).toStartWith("openai::");
    expect(publicFallback).not.toBe(
      `openai::${MODEL_DEFAULTS_LEDGER.chat.openai.candidate.modelId}`,
    );
    expect(
      isModelSelectionAvailableForTask({
        dataClass: "customer",
        provider: "openai",
        modelId: MODEL_DEFAULTS_LEDGER.chat.openai.candidate.modelId,
        orgAIConfig: null,
        task: "chat",
      }),
    ).toBe(false);
    for (const managedAIResidency of ["eu", "us"] as const) {
      expect(
        getStructuredOutputFallbackModelId({
          failedModelId: MODEL_DEFAULTS_LEDGER.chat.openai.candidate.modelId,
          orgAIConfig: null,
          task: "chat",
          modelTier: MANAGED_MODEL_TIER.standard,
          dataClass: "customer",
          managedAIResidency,
        }),
      ).toBeNull();
    }
  });

  test("managed fallback uses the active provider's regional policy", () => {
    testState.setConfig("AI_PROVIDER", "openrouter");
    testState.setConfig("OPENROUTER_API_KEY", "test-openrouter-instance-key");
    testState.setConfig("REQUIRE_PERSONAL_AI_KEY", false);
    testState.setConfig("USE_MOCK_AI", false);
    for (const managedAIResidency of ["eu", "us"] as const) {
      const fallback = getStructuredOutputFallbackModelId({
        failedModelId: MODEL_DEFAULTS_LEDGER.chat.openrouter.candidate.modelId,
        orgAIConfig: null,
        task: "chat",
        modelTier: MANAGED_MODEL_TIER.standard,
        dataClass: "customer",
        managedAIResidency,
      });
      expect(fallback).toStartWith("openrouter::");
      expect(fallback).not.toBe(
        `openrouter::${MODEL_DEFAULTS_LEDGER.chat.openrouter.candidate.modelId}`,
      );
    }
  });

  test("managed fast tier skips because model resolution pins its primary", () => {
    testState.setConfig("AI_PROVIDER", "openrouter");
    expect(
      getStructuredOutputFallbackModelId({
        failedModelId:
          MODEL_DEFAULTS_LEDGER["short-text"].openrouter.candidate.modelId,
        orgAIConfig: null,
        task: "chat",
        modelTier: MANAGED_MODEL_TIER.fast,
        dataClass: "customer",
        managedAIResidency: "eu",
      }),
    ).toBeNull();
  });
});
