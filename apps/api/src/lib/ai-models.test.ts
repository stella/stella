import { APICallError } from "@ai-sdk/provider";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { AIProvider, ModelRole, OrgAIConfig } from "@/api/lib/ai-models";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";

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
  FALLBACK_FROM_SERVICE_TIER_PROVIDER_METADATA_KEY,
  SERVICE_TIER_PROVIDER_METADATA_KEY,
  STELLA_PROVIDER_METADATA_KEY,
  createServiceTierMiddleware,
  defaultsForRole,
  getModelForRole,
  getModelInfoById,
  getModelInfoForRole,
  isAllowedBYOKModel,
  isDeferredServiceTierAvailableForRole,
  REGIONAL_PROVIDERS,
  resolveCaching,
  resolveEffectiveServiceTierForProvider,
  resolveServiceTierProviderOptions,
  supportsRegion,
  validateDevModelOverride,
} = await import("@/api/lib/ai-models");

const TEST_GENERATE_RESULT: LanguageModelV3GenerateResult = {
  content: [],
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: {
      total: 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: 0,
      text: 0,
      reasoning: 0,
    },
  },
  warnings: [],
};

const TEST_STREAM_RESULT: LanguageModelV3StreamResult = {
  stream: new ReadableStream({
    start: (controller) => {
      controller.close();
    },
  }),
};

const createFinishStreamResult = (): LanguageModelV3StreamResult => ({
  stream: new ReadableStream<LanguageModelV3StreamPart>({
    start: (controller) => {
      controller.enqueue({
        type: "finish",
        finishReason: TEST_GENERATE_RESULT.finishReason,
        usage: TEST_GENERATE_RESULT.usage,
      });
      controller.close();
    },
  }),
});

const createAPIError = ({
  isRetryable,
  statusCode,
}: {
  isRetryable?: boolean;
  statusCode: number;
}) =>
  new APICallError({
    message: "provider error",
    requestBodyValues: {},
    statusCode,
    url: "https://example.test/v1/chat/completions",
    ...(isRetryable === undefined ? {} : { isRetryable }),
  });

const TEST_PARAMS: LanguageModelV3CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

const createRecordingModel = (
  onGenerate: (params: LanguageModelV3CallOptions) => void,
  onStream?: (params: LanguageModelV3CallOptions) => void,
): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: "test",
  modelId: "test-model",
  supportedUrls: {},
  doGenerate: async (params) => {
    onGenerate(params);
    return TEST_GENERATE_RESULT;
  },
  doStream: async (params) => {
    onStream?.(params);
    return createFinishStreamResult();
  },
});

const settingsForRole = (
  role: ModelRole,
  provider: AIProvider,
  orgId: SafeId<"organization"> | null = null,
  modelId: string = DEFAULT_MODELS[provider][role],
) =>
  defaultsForRole({
    role,
    provider,
    orgId,
    modelId,
  });

const orgConfigForProvider = (
  provider: Extract<AIProvider, "anthropic" | "google" | "openai">,
  region?: "eu" | "global" | "ch",
) => ({
  providers: [
    {
      provider,
      apiKey: "sk-test",
      ...(region === undefined ? {} : { region }),
    },
  ],
  overrideModels: {
    chat: { provider, modelId: DEFAULT_MODELS[provider].chat },
    fast: { provider, modelId: DEFAULT_MODELS[provider].fast },
    pdf: { provider, modelId: DEFAULT_MODELS[provider].pdf },
    reasoning: { provider, modelId: DEFAULT_MODELS[provider].reasoning },
  },
});

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
      "huggingface",
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
    expect(isAllowedBYOKModel("huggingface", "customer-model")).toBe(true);
    expect(isAllowedBYOKModel("openrouter", "anthropic/claude-opus-4.8")).toBe(
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
    expect(isAllowedBYOKModel("huggingface", "")).toBe(false);
    expect(isAllowedBYOKModel("huggingface", "   ")).toBe(false);
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
        fast: { provider: "google", modelId: "gemini-3.1-flash-lite" },
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
        fast: { provider: "google", modelId: "gemini-3.1-flash-lite" },
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
        fast: { provider: "google", modelId: "gemini-3.1-flash-lite" },
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
          modelId: "gemini-3.1-flash-lite",
        },
        chat: {
          provider: "google",
          modelId: "gemini-3.1-flash-lite",
        },
        fast: {
          provider: "google",
          modelId: "gemini-3.1-flash-lite",
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

  test("routes every stella role through configured OpenRouter models", () => {
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
          modelId: "google/gemini-3.1-flash-lite",
        },
        chat: {
          provider: "openrouter",
          modelId: "anthropic/claude-sonnet-4.6",
        },
        reasoning: {
          provider: "openrouter",
          modelId: "google/gemini-3.1-pro-preview",
        },
        pdf: {
          provider: "openrouter",
          modelId: "google/gemini-3.1-flash-lite",
        },
      },
    };

    for (const role of ["fast", "chat", "reasoning", "pdf"] as const) {
      expect(getModelInfoForRole(role, orgConfig)).toMatchObject({
        keySource: "byok",
        provider: "openrouter",
        modelId: orgConfig.overrideModels[role].modelId,
      });
      expect(() =>
        getModelForRole(role, orgConfig, {
          promptCachingEnabled: true,
          scopeKey: null,
          organizationId: null,
          serviceTier: "standard",
        }),
      ).not.toThrow();
    }
  });

  test("routes every stella role through configured Mistral models", () => {
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
      expect(() =>
        getModelForRole(role, orgConfig, {
          promptCachingEnabled: true,
          scopeKey: null,
          organizationId: null,
          serviceTier: "standard",
        }),
      ).not.toThrow();
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

    expect(() =>
      getModelForRole("reasoning", orgConfig, {
        promptCachingEnabled: true,
        scopeKey: null,
        organizationId: null,
        serviceTier: "standard",
      }),
    ).not.toThrow();
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
    expect(() =>
      getModelForRole("chat", orgConfig, {
        promptCachingEnabled: true,
        scopeKey: null,
        organizationId: null,
        serviceTier: "standard",
      }),
    ).not.toThrow();
  });
});

describe("resolveCaching", () => {
  test("returns enabled when the org has caching on", () => {
    const decision = resolveCaching({
      promptCachingEnabled: true,
      role: "pdf",
      scopeKey: "entity-1",
    });
    expect(decision).toEqual({
      enabled: true,
      ttl: "5m",
      scopeKey: "entity-1",
    });
  });

  test("returns disabled with org-disabled reason when caching is off", () => {
    const decision = resolveCaching({
      promptCachingEnabled: false,
      role: "chat",
      scopeKey: "thread-1",
    });
    expect(decision).toEqual({
      enabled: false,
      reason: "org-disabled",
    });
  });

  test("accepts null scopeKey when caching is on (opportunistic only)", () => {
    const decision = resolveCaching({
      promptCachingEnabled: true,
      role: "fast",
      scopeKey: null,
    });
    expect(decision).toMatchObject({ enabled: true, scopeKey: null });
  });
});

describe("resolveServiceTierProviderOptions", () => {
  test("maps standard calls to explicit normal-priced provider tiers", () => {
    expect(
      resolveServiceTierProviderOptions({
        target: "google_gemini_api",
        serviceTier: "standard",
      }),
    ).toEqual({ google: { serviceTier: "standard" } });
    expect(
      resolveServiceTierProviderOptions({
        target: "openai",
        serviceTier: "standard",
      }),
    ).toEqual({ openai: { serviceTier: "default" } });
  });

  test("maps flex and batch calls to provider flex where supported", () => {
    for (const serviceTier of ["flex", "batch"] as const) {
      expect(
        resolveServiceTierProviderOptions({
          target: "google_gemini_api",
          serviceTier,
        }),
      ).toEqual({ google: { serviceTier: "flex" } });
      expect(
        resolveServiceTierProviderOptions({
          target: "openai",
          serviceTier,
        }),
      ).toEqual({ openai: { serviceTier: "flex" } });
    }
  });

  test("maps Vertex deferred calls to shared flex PayGo headers", () => {
    expect(
      resolveServiceTierProviderOptions({
        target: "google_vertex",
        serviceTier: "flex",
      }),
    ).toEqual({
      vertex: {
        sharedRequestType: "flex",
        requestType: "shared",
      },
    });
  });

  test("omits provider options when no equivalent is known", () => {
    expect(
      resolveServiceTierProviderOptions({
        target: "none",
        serviceTier: "flex",
      }),
    ).toBeUndefined();
    expect(
      resolveServiceTierProviderOptions({
        target: "google_vertex",
        serviceTier: "standard",
      }),
    ).toBeUndefined();
  });
});

describe("resolveEffectiveServiceTierForProvider", () => {
  test("keeps deferred tiers only for providers with known equivalents", () => {
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
        provider: "anthropic",
        serviceTier: "flex",
      }),
    ).toBe("standard");
  });
});

describe("isDeferredServiceTierAvailableForRole", () => {
  test("returns true for org providers with deferred tier support", () => {
    expect(
      isDeferredServiceTierAvailableForRole(
        "pdf",
        orgConfigForProvider("google"),
      ),
    ).toBe(true);
    expect(
      isDeferredServiceTierAvailableForRole(
        "pdf",
        orgConfigForProvider("openai"),
      ),
    ).toBe(true);
  });

  test("returns false for org providers without deferred tier support", () => {
    expect(
      isDeferredServiceTierAvailableForRole(
        "pdf",
        orgConfigForProvider("anthropic"),
      ),
    ).toBe(false);
  });
});

describe("service tier fallback middleware", () => {
  test("retries deferred generate calls once with standard provider options", async () => {
    const middleware = createServiceTierMiddleware("openai", "flex");
    const flexParams = await middleware.transformParams?.({
      model: createRecordingModel(() => undefined),
      params: TEST_PARAMS,
      type: "generate",
    });
    if (!flexParams) {
      throw new Error("Expected service tier middleware to transform params");
    }

    let fallbackParams: LanguageModelV3CallOptions | undefined;
    const result = await middleware.wrapGenerate?.({
      doGenerate: async () => {
        throw createAPIError({ statusCode: 429 });
      },
      doStream: async () => TEST_STREAM_RESULT,
      model: createRecordingModel((params) => {
        fallbackParams = params;
      }),
      params: flexParams,
    });

    expect(fallbackParams?.providerOptions?.["openai"]).toEqual({
      serviceTier: "default",
    });
    expect(
      result?.providerMetadata?.[STELLA_PROVIDER_METADATA_KEY]?.[
        SERVICE_TIER_PROVIDER_METADATA_KEY
      ],
    ).toBe("standard");
    expect(
      result?.providerMetadata?.[STELLA_PROVIDER_METADATA_KEY]?.[
        FALLBACK_FROM_SERVICE_TIER_PROVIDER_METADATA_KEY
      ],
    ).toBe("flex");
  });

  test("does not fallback non-retryable deferred errors", async () => {
    const middleware = createServiceTierMiddleware("openai", "flex");
    const apiError = createAPIError({ isRetryable: false, statusCode: 400 });
    let fallbackCount = 0;

    const result = middleware.wrapGenerate?.({
      doGenerate: async () => {
        throw apiError;
      },
      doStream: async () => TEST_STREAM_RESULT,
      model: createRecordingModel(() => {
        fallbackCount++;
      }),
      params: TEST_PARAMS,
    });
    if (!result) {
      throw new Error("Expected service tier middleware to wrap generate");
    }

    let caughtError: unknown;
    try {
      await result;
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(apiError);
    expect(fallbackCount).toBe(0);
  });

  test("does not fallback retryable errors when standard fallback is disabled", async () => {
    const middleware = createServiceTierMiddleware("openai", "flex", {
      allowFallbackToStandard: false,
    });
    const apiError = createAPIError({ statusCode: 429 });
    let fallbackCount = 0;

    const result = middleware.wrapGenerate?.({
      doGenerate: async () => {
        throw apiError;
      },
      doStream: async () => TEST_STREAM_RESULT,
      model: createRecordingModel(() => {
        fallbackCount++;
      }),
      params: TEST_PARAMS,
    });
    if (!result) {
      throw new Error("Expected service tier middleware to wrap generate");
    }

    let caughtError: unknown;
    try {
      await result;
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(apiError);
    expect(fallbackCount).toBe(0);
  });

  test("removes Vertex Flex shared-request options for standard fallback", async () => {
    const middleware = createServiceTierMiddleware("google_vertex", "flex");
    const flexParams = await middleware.transformParams?.({
      model: createRecordingModel(() => undefined),
      params: {
        ...TEST_PARAMS,
        providerOptions: {
          vertex: {
            thinkingConfig: { thinkingLevel: "minimal" },
          },
        },
      },
      type: "generate",
    });
    if (!flexParams) {
      throw new Error("Expected service tier middleware to transform params");
    }

    let fallbackParams: LanguageModelV3CallOptions | undefined;
    await middleware.wrapGenerate?.({
      doGenerate: async () => {
        throw createAPIError({ statusCode: 503 });
      },
      doStream: async () => TEST_STREAM_RESULT,
      model: createRecordingModel((params) => {
        fallbackParams = params;
      }),
      params: flexParams,
    });

    expect(fallbackParams?.providerOptions?.["vertex"]).toEqual({
      thinkingConfig: { thinkingLevel: "minimal" },
    });
  });

  test("retries deferred stream calls with standard provider options", async () => {
    const middleware = createServiceTierMiddleware("openai", "batch");
    const flexParams = await middleware.transformParams?.({
      model: createRecordingModel(() => undefined),
      params: TEST_PARAMS,
      type: "stream",
    });
    if (!flexParams) {
      throw new Error("Expected service tier middleware to transform params");
    }

    let fallbackParams: LanguageModelV3CallOptions | undefined;
    const result = await middleware.wrapStream?.({
      doGenerate: async () => TEST_GENERATE_RESULT,
      doStream: async () => {
        throw createAPIError({ statusCode: 429 });
      },
      model: createRecordingModel(
        () => undefined,
        (params) => {
          fallbackParams = params;
        },
      ),
      params: flexParams,
    });

    const chunks: LanguageModelV3StreamPart[] = [];
    await result?.stream.pipeTo(
      new WritableStream({
        write: (chunk: LanguageModelV3StreamPart) => {
          chunks.push(chunk);
        },
      }),
    );
    const finishChunk = chunks.find((chunk) => chunk.type === "finish");

    expect(fallbackParams?.providerOptions?.["openai"]).toEqual({
      serviceTier: "default",
    });
    expect(
      finishChunk?.providerMetadata?.[STELLA_PROVIDER_METADATA_KEY]?.[
        SERVICE_TIER_PROVIDER_METADATA_KEY
      ],
    ).toBe("standard");
    expect(
      finishChunk?.providerMetadata?.[STELLA_PROVIDER_METADATA_KEY]?.[
        FALLBACK_FROM_SERVICE_TIER_PROVIDER_METADATA_KEY
      ],
    ).toBe("batch");
  });
});

describe("defaultsForRole", () => {
  test("temperature is 0 for every role", () => {
    for (const role of ["fast", "chat", "reasoning", "pdf"] as const) {
      for (const provider of [
        "google",
        "anthropic",
        "openai",
        "azure_foundry",
        "openrouter",
        "mistral",
        "openai_compatible",
        "huggingface",
      ] as const) {
        // Anthropic + reasoning intentionally omits temperature
        // (incompatible with extended thinking on Claude pre-Opus-4.7).
        if (provider === "anthropic" && role === "reasoning") {
          continue;
        }
        expect(settingsForRole(role, provider)).toMatchObject({
          temperature: 0,
        });
      }
    }
  });

  test("anthropic reasoning omits temperature", () => {
    const settings = settingsForRole("reasoning", "anthropic");
    expect(settings.temperature).toBeUndefined();
  });

  test("google fast/chat/pdf use minimal thinking; reasoning uses high", () => {
    for (const role of ["fast", "chat", "pdf"] as const) {
      const s = settingsForRole(role, "google");
      expect(s.providerOptions?.["google"]).toMatchObject({
        thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false },
      });
    }
    const reasoning = settingsForRole("reasoning", "google");
    expect(reasoning.providerOptions?.["google"]).toMatchObject({
      thinkingConfig: { thinkingLevel: "high", includeThoughts: false },
    });
  });

  test("google providerOptions include safetySettings baseline", () => {
    const settings = settingsForRole("fast", "google");
    const google = settings.providerOptions?.["google"] as
      | { safetySettings?: { category: string; threshold: string }[] }
      | undefined;
    expect(google?.safetySettings).toBeDefined();
    expect(google?.safetySettings?.length).toBeGreaterThan(0);
    expect(
      google?.safetySettings?.every(
        (rule) => rule.threshold === "BLOCK_ONLY_HIGH",
      ),
    ).toBe(true);
  });

  test("anthropic includes hashed metadata.userId when orgId is given", () => {
    // SAFETY: SafeId is a branded string; the helper only hashes the
    // value, so a raw string is sound at runtime for this unit test.
    const orgId = toSafeId<"organization">("org_test_abc123");
    const settings = settingsForRole("fast", "anthropic", orgId);
    const anthropic = settings.providerOptions?.["anthropic"] as
      | { metadata?: { userId?: string } & Record<string, unknown> }
      | undefined;
    const metadata = anthropic?.metadata;
    expect(metadata?.userId).toBeDefined();
    expect(metadata?.userId).not.toBe("org_test_abc123");
    expect(metadata?.userId?.length).toBe(16);
    expect("user_id" in (metadata ?? {})).toBe(false);
  });

  test("anthropic reasoning enables adaptive thinking", () => {
    const settings = settingsForRole("reasoning", "anthropic");
    expect(settings.providerOptions?.["anthropic"]).toMatchObject({
      thinking: { type: "adaptive" },
    });
  });

  test("anthropic reasoning uses budget thinking for Claude 4.5", () => {
    const settings = settingsForRole(
      "reasoning",
      "anthropic",
      null,
      "claude-haiku-4-5-20251001",
    );
    expect(settings.temperature).toBeUndefined();
    expect(settings.providerOptions?.["anthropic"]).toMatchObject({
      thinking: { type: "enabled", budgetTokens: 10_000 },
    });
  });

  test("anthropic fast/chat/pdf do not enable thinking", () => {
    for (const role of ["fast", "chat", "pdf"] as const) {
      const s = settingsForRole(role, "anthropic");
      const anthropic = s.providerOptions?.["anthropic"] as
        | { thinking?: unknown }
        | undefined;
      expect(anthropic?.thinking).toBeUndefined();
    }
  });

  test("openai reasoning sets reasoningEffort under openai key", () => {
    const settings = settingsForRole("reasoning", "openai");
    expect(settings.providerOptions?.["openai"]).toMatchObject({
      reasoningEffort: "medium",
    });
  });

  test("azure_foundry reasoning sets reasoningEffort under azure key", () => {
    const settings = settingsForRole("reasoning", "azure_foundry");
    expect(settings.providerOptions?.["azure"]).toMatchObject({
      reasoningEffort: "medium",
    });
    expect(settings.providerOptions?.["openai"]).toBeUndefined();
  });

  test("openai non-reasoning roles set no provider options", () => {
    for (const role of ["fast", "chat", "pdf"] as const) {
      const settings = settingsForRole(role, "openai");
      expect(settings.providerOptions).toBeUndefined();
    }
  });
});
