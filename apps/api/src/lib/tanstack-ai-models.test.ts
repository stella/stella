import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { describe, expect, spyOn, test } from "bun:test";

import {
  BYOK_DOCUMENT_INPUT_MODEL_OPTIONS,
  BYOK_DEFAULT_MODELS,
  BYOK_MODEL_OPTIONS,
  CHAT_PDF_ATTACHMENT_MODEL_OPTIONS,
  getModelReasoningEfforts,
  isBYOKProviderRoleSupported,
  MODEL_ROLES,
  shouldEmitTemperature,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";

import { env } from "@/api/env";
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
  getTanStackTextModelInfoForRole,
  getTanStackTextModelById,
  getTanStackTextModelForRole,
  hasTanStackInstanceProvider,
  isAllowedBYOKModel,
  isAllowedBYOKModelForRole,
  isDeferredServiceTierAvailableForRole,
  isMockTextAdapter,
  isTanStackAIProviderSupported,
  mockAnswersForOrganization,
  modelAcceptsPdfDocumentInput,
  modelAcceptsStreamingToolUse,
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
        getTanStackTextModelForRole("chat", null, {
          dataClass: "customer",
          managedAIResidency: "eu",
          organizationId: orgId,
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
        getTanStackTextModelForRole("chat", null, {
          dataClass: "customer",
          managedAIResidency: "eu",
          organizationId: orgId,
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
        role: "reasoning",
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
      },
    );

    expect(model).toMatchObject({
      keySource: "byok",
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
        dataClass: "public_corpus",
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
      {
        role: "chat",
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: null,
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
          role: "chat",
          dataClass: "customer",
          managedAIResidency: "eu",
          organizationId: null,
        },
      );

      expect(looseOptions(model.modelOptions).thinkingConfig).toBeUndefined();
    } finally {
      testState.setConfig("GOOGLE_GENERATIVE_AI_API_KEY", originalKey);
    }
  });

  test("resolves Mistral BYOK selections through the TanStack adapter", () => {
    const orgConfig = orgConfigForProvider("mistral");

    const model = getTanStackTextModelForRole("chat", orgConfig, {
      dataClass: "customer",
      managedAIResidency: "eu",
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
        dataClass: "customer",
        managedAIResidency: "eu",
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
      dataClass: "customer",
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
        dataClass: "customer",
        managedAIResidency: "eu",
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

  test.each(["customer", "public_corpus"] as const)(
    "rejects unavailable instance requests for %s in role availability preflight",
    (dataClass) => {
      const originalProvider = env.AI_PROVIDER;
      try {
        testState.setConfig("AI_PROVIDER", "mistral");

        const unavailable = requireTanStackAIAvailableForRole({
          configStatus: ORG_AI_CONFIG_STATUS.ok,
          dataClass,
          orgConfig: null,
          role: "pdf",
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

    const model = getTanStackTextModelForRole("chat", orgConfig, {
      dataClass: "customer",
      managedAIResidency: "eu",
      organizationId: orgId,
    });

    expect(modelAcceptsStreamingToolUse(model)).toBe(true);
    expect(model.adapter.structuredOutputStream).toBeDefined();
  });

  test("resolves Bedrock BYOK selections through the TanStack adapter", () => {
    const orgConfig = orgConfigForProvider("bedrock");

    const model = getTanStackTextModelForRole("chat", orgConfig, {
      dataClass: "customer",
      managedAIResidency: "eu",
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

  test.each(["within-limit", "oversized"] as const)(
    "sends a Bedrock model a valid %s image within provider limits",
    async (size) => {
      const orgConfig = orgConfigForProvider("bedrock");
      orgConfig.overrideModels.chat = {
        provider: "bedrock",
        modelId: "us.amazon.nova-lite-v1:0",
      };
      const model = getTanStackTextModelForRole("chat", orgConfig, {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
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
                        : Buffer.from(png).toString("base64"),
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
      const model = getTanStackTextModelForRole("chat", orgConfig, {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
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

    const model = getTanStackTextModelForRole("chat", orgConfig, {
      dataClass: "customer",
      managedAIResidency: "eu",
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
        dataClass: "customer",
        orgConfig: orgConfigForProvider("openai"),
        role: "chat",
      }).isOk(),
    ).toBe(true);

    const unavailable = requireTanStackAIAvailableForRole({
      configStatus: ORG_AI_CONFIG_STATUS.ok,
      dataClass: "customer",
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
      dataClass: "customer",
      orgConfig: orgConfigForProvider("mistral"),
      role: "pdf",
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
      const refused = requireTanStackAIAvailableForRole({
        configStatus,
        dataClass: "customer",
        orgConfig: null,
        role: "chat",
      });

      expect(refused.isErr()).toBe(true);
      if (refused.isErr()) {
        expect(refused.error.status).toBe(status);
      }
    }
  });

  test("refuses a member without a seat assignment on the organization's own key", () => {
    const refused = requireTanStackAIAvailableForRole({
      configStatus: ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
      dataClass: "customer",
      orgConfig: orgConfigForProvider("openrouter"),
      role: "chat",
    });

    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) {
      expect(refused.error.status).toBe(403);
      expect(refused.error.code).toBe(AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE);
    }
  });

  test("exposes TanStack model metadata without leaking the adapter", () => {
    const modelInfo = getTanStackTextModelInfoForRole(
      "chat",
      orgConfigForProvider("openrouter"),
      { dataClass: "customer", organizationId: orgId },
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
    // Models whose catalogued temperature policy is "omit" reject any
    // temperature but the default (a 400), so no role may emit
    // `temperature` for them.
    const options = tanStackModelOptionsForRole({
      role: "chat",
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
    const options = tanStackModelOptionsForRole({
      role: "chat",
      provider: "openai",
      modelId: "some-custom-openai-model",
      organizationId: null,
    });

    expect(options).toEqual({});
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
      const model = getTanStackTextModelForRole("chat", orgConfig, {
        dataClass: "customer",
        managedAIResidency: "eu",
        organizationId: orgId,
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
        getTanStackTextModelForRole("chat", null, {
          dataClass: "customer",
          managedAIResidency: "eu",
          organizationId: orgId,
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
  test("every model role receives workspace headers and changed workspace invalidates the cached factory", async () => {
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
        for (const role of MODEL_ROLES) {
          const model = getTanStackTextModelForRole(role, config, {
            organizationId: orgId,
            dataClass: "customer",
            managedAIResidency: "eu",
          });
          const before = requests.length;
          for await (const _chunk of model.adapter.chatStream({
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

test("unoverridden organization roles dispatch the catalog default with truthful role availability", () => {
  for (const provider of TANSTACK_AI_PROVIDERS) {
    const config = {
      providers: [{ provider, apiKey: "fixture-key" }],
      overrideModels: null,
      decision: null,
    } satisfies OrgAIConfig;
    for (const role of MODEL_ROLES) {
      const supported = isBYOKProviderRoleSupported({ provider, role });
      const available = requireTanStackAIAvailableForRole({
        configStatus: ORG_AI_CONFIG_STATUS.ok,
        dataClass: "customer",
        orgConfig: config,
        role,
      });
      expect(available.isOk()).toBe(supported);
      const entry = BYOK_DEFAULT_MODELS[provider][role];
      if (entry.kind === "unsupported") {
        continue;
      }
      expect(
        getTanStackTextModelInfoForRole(role, config, {
          dataClass: "customer",
          organizationId: orgId,
        }),
      ).toMatchObject({
        provider,
        modelId: entry.modelId,
        keySource: "byok",
      });
    }
  }
});
