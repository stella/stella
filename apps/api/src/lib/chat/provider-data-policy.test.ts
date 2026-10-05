import { EventType } from "@tanstack/ai";
import type { AdapterYieldChunk } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { TanStackAIProvider } from "@stll/ai-catalog";
import {
  AI_PROVIDERS,
  BYOK_MODEL_OPTIONS,
  DEFAULT_MODELS,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";

import { env } from "@/api/env";
import { DECISION_MODEL_PROVIDERS } from "@/api/lib/ai-config";
import type {
  AIDataClass,
  AIRequestPolicy,
} from "@/api/lib/chat/ai-data-policy";
import { MANAGED_AI_RESIDENCIES } from "@/api/lib/chat/ai-data-policy";
import {
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  PROVIDER_DATA_POLICY,
  assertManagedOpenRouterModel,
  isManagedProviderAvailable,
} from "@/api/lib/chat/provider-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import {
  readEvidence,
  readProviderStatus,
} from "@/api/lib/observability/failure-evidence";
import {
  createTanStackTextAdapterFactory,
  getTanStackTextModelById,
  getTanStackTextModelForRole,
  getTanStackTextModelInfoById,
  getTanStackTextModelInfoForRole,
  resolveTanStackAIProviderSupport,
} from "@/api/lib/tanstack-ai-models";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import {
  findTranscriptProblems,
  providerWireFormatOf,
} from "@/api/tests/helpers/provider-request-transcript";

const REQUEST_TEXT = "Reply with OK.";
const REQUEST_API_KEY = "test-request-key";

const ORIGINAL_REQUESTS = {
  openai: (model: string) => ({
    url: "https://api.openai.com/v1/responses",
    modelOptions: { max_output_tokens: 64 },
    authorization: `Bearer ${REQUEST_API_KEY}`,
    apiKey: null,
    body: {
      max_output_tokens: 64,
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: REQUEST_TEXT }],
        },
      ],
      stream: true,
    },
  }),
  anthropic: (model: string) => ({
    url: "https://api.anthropic.com/v1/messages?beta=true",
    modelOptions: { max_tokens: 64 },
    authorization: null,
    apiKey: REQUEST_API_KEY,
    body: {
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: REQUEST_TEXT }],
      stream: true,
    },
  }),
  google: (model: string) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    modelOptions: { maxOutputTokens: 64 },
    authorization: null,
    apiKey: REQUEST_API_KEY,
    body: {
      contents: [{ parts: [{ text: REQUEST_TEXT }], role: "user" }],
      generationConfig: { maxOutputTokens: 64 },
      tools: [],
    },
  }),
  bedrock: (model: string) => ({
    url: `https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid/model/${encodeURIComponent(model)}/converse-stream`,
    modelOptions: { max_completion_tokens: 64 },
    authorization: `Bearer ${REQUEST_API_KEY}`,
    apiKey: null,
    body: {
      messages: [{ role: "user", content: [{ text: REQUEST_TEXT }] }],
      inferenceConfig: { maxTokens: 64 },
    },
  }),
  mistral: (model: string) => ({
    url: "https://api.mistral.ai/v1/chat/completions",
    modelOptions: { max_tokens: 64 },
    authorization: `Bearer ${REQUEST_API_KEY}`,
    apiKey: null,
    body: {
      model,
      messages: [{ role: "user", content: REQUEST_TEXT }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
    },
  }),
  openrouter: (model: string) => ({
    url: "https://openrouter.ai/api/v1/chat/completions",
    modelOptions: { maxCompletionTokens: 64 },
    authorization: `Bearer ${REQUEST_API_KEY}`,
    apiKey: null,
    body: {
      model,
      messages: [{ role: "user", content: REQUEST_TEXT }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 64,
    },
  }),
} as const satisfies Record<
  TanStackAIProvider,
  (model: string) => {
    url: string;
    modelOptions: Record<string, unknown>;
    authorization: string | null;
    apiKey: string | null;
    body: unknown;
  }
>;

describe("provider request policy", () => {
  test("requires a configured Bedrock organization credential", () => {
    const previousMock = env.USE_MOCK_AI;
    const previousKey = env.BEDROCK_API_KEY;
    env.BEDROCK_API_KEY = "test-instance-key";
    try {
      for (const mockMode of [false, true]) {
        env.USE_MOCK_AI = mockMode;
        for (const apiKey of ["", " ", "\t\n "]) {
          for (const dataClass of ["customer", "public_corpus"] as const) {
            const resolved = Result.try({
              try: () =>
                createTanStackTextAdapterFactory({
                  provider: "bedrock",
                  apiKey,
                  dataClass,
                }),
              catch: (error) => error,
            });
            expect(Result.isError(resolved)).toBe(true);
            if (Result.isError(resolved)) {
              expect(HandlerError.is(resolved.error)).toBe(true);
              expect(resolved.error).toMatchObject({
                status: 403,
                message:
                  'BEDROCK_API_KEY is required for TanStack AI provider "bedrock".',
              });
            }
          }
        }
      }
    } finally {
      env.USE_MOCK_AI = previousMock;
      env.BEDROCK_API_KEY = previousKey;
    }
  });

  test("every provider declares its request policy", () => {
    expect(Object.keys(PROVIDER_DATA_POLICY.customer).toSorted()).toEqual(
      [
        ...AI_PROVIDERS,
        ...DECISION_MODEL_PROVIDERS,
        "agent_sandbox",
      ].toSorted(),
    );
  });

  test("reports managed availability for every data class and provider", () => {
    for (const provider of [
      ...AI_PROVIDERS,
      ...DECISION_MODEL_PROVIDERS,
      "agent_sandbox",
    ] as const) {
      expect(isManagedProviderAvailable(provider, "public_corpus")).toBe(true);
      expect(isManagedProviderAvailable(provider, "customer")).toBe(
        provider === "openrouter",
      );
    }
  });

  test("request factories enforce the provider policy for every data class and check mode", () => {
    const previous = {
      USE_MOCK_AI: env.USE_MOCK_AI,
      FEATURE_MANAGED_PROVIDER_CHECKS: env.FEATURE_MANAGED_PROVIDER_CHECKS,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      BEDROCK_API_KEY: env.BEDROCK_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY,
      MISTRAL_API_KEY: env.MISTRAL_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    };
    const dataClasses = {
      customer: "customer",
      public_corpus: "public_corpus",
    } as const satisfies { [DataClass in AIDataClass]: DataClass };
    Object.assign(env, {
      USE_MOCK_AI: false,
      ANTHROPIC_API_KEY: REQUEST_API_KEY,
      BEDROCK_API_KEY: REQUEST_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: REQUEST_API_KEY,
      MISTRAL_API_KEY: REQUEST_API_KEY,
      OPENAI_API_KEY: REQUEST_API_KEY,
      OPENROUTER_API_KEY: REQUEST_API_KEY,
    });
    try {
      for (const enabled of [false, true]) {
        env.FEATURE_MANAGED_PROVIDER_CHECKS = enabled;
        for (const provider of AI_PROVIDERS) {
          for (const dataClass of Object.values(dataClasses)) {
            for (const managedAIResidency of MANAGED_AI_RESIDENCIES) {
              const policy =
                dataClass === "customer"
                  ? { dataClass, managedAIResidency }
                  : { dataClass };
              const result = Result.try({
                try: () =>
                  createTanStackTextAdapterFactory({ provider, ...policy }),
                catch: (error) => error,
              });
              if (dataClass === "customer" && provider !== "openrouter") {
                expect(result.isErr()).toBe(true);
                if (Result.isError(result)) {
                  expect(result.error).toMatchObject({
                    status: 503,
                    code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                  });
                }
                continue;
              }
              expect(result.isOk()).toBe(
                resolveTanStackAIProviderSupport({ provider }).supported,
              );
              if (Result.isError(result)) {
                expect(result.error).not.toMatchObject({
                  code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                });
              }
            }
          }
        }
      }
    } finally {
      Object.assign(env, previous);
    }
  });

  test("resolves model metadata independently of request availability", () => {
    const previous = {
      USE_MOCK_AI: env.USE_MOCK_AI,
      AI_PROVIDER: env.AI_PROVIDER,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      BEDROCK_API_KEY: env.BEDROCK_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY,
      MISTRAL_API_KEY: env.MISTRAL_API_KEY,
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    };
    Object.assign(env, {
      USE_MOCK_AI: false,
      ANTHROPIC_API_KEY: REQUEST_API_KEY,
      BEDROCK_API_KEY: REQUEST_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: REQUEST_API_KEY,
      MISTRAL_API_KEY: REQUEST_API_KEY,
      OPENAI_API_KEY: REQUEST_API_KEY,
      OPENROUTER_API_KEY: REQUEST_API_KEY,
    });
    try {
      for (const provider of AI_PROVIDERS) {
        if (!resolveTanStackAIProviderSupport({ provider }).supported) {
          continue;
        }
        env.AI_PROVIDER = provider;
        for (const dataClass of ["customer", "public_corpus"] as const) {
          const available = isManagedProviderAvailable(provider, dataClass);
          const info = getTanStackTextModelInfoForRole("chat", null, {
            organizationId: null,
            dataClass,
            modelTier: MANAGED_MODEL_TIER.standard,
          });
          expect(info).toMatchObject({
            keySource: "instance",
            provider,
            availability: available ? "available" : "unavailable",
          });
          const selection = `${provider}::${info.modelId}`;
          expect(
            getTanStackTextModelInfoById(selection, null, "chat", {
              dataClass,
              modelTier: MANAGED_MODEL_TIER.standard,
            }),
          ).toMatchObject(info);
          for (const managedAIResidency of MANAGED_AI_RESIDENCIES) {
            const policy =
              dataClass === "customer"
                ? { dataClass, managedAIResidency }
                : { dataClass };
            const options = {
              organizationId: null,
              modelTier: MANAGED_MODEL_TIER.standard,
              ...policy,
            };
            if (!available) {
              expect(() =>
                getTanStackTextModelForRole("chat", null, options),
              ).toThrow("Managed AI is not available");
              expect(() =>
                getTanStackTextModelById(selection, null, {
                  role: "chat",
                  ...options,
                }),
              ).toThrow("Managed AI is not available");
              continue;
            }
            expect(
              getTanStackTextModelForRole("chat", null, options),
            ).toMatchObject({
              keySource: info.keySource,
              modelId: info.modelId,
              provider: info.provider,
            });
            expect(
              getTanStackTextModelById(selection, null, {
                role: "chat",
                ...options,
              }),
            ).toMatchObject({
              keySource: info.keySource,
              modelId: info.modelId,
              provider: info.provider,
            });
          }
        }
      }
    } finally {
      Object.assign(env, previous);
    }
  });

  test("applies customer request policy for every provider and residency", () => {
    const previousMock = env.USE_MOCK_AI;
    const previousKey = env.OPENROUTER_API_KEY;
    env.USE_MOCK_AI = false;
    env.OPENROUTER_API_KEY = "test-instance-key";
    try {
      for (const provider of AI_PROVIDERS) {
        for (const managedAIResidency of MANAGED_AI_RESIDENCIES) {
          const options = {
            provider,
            dataClass: "customer" as const,
            managedAIResidency,
          };
          if (provider === "openrouter") {
            expect(
              createTanStackTextAdapterFactory(options)(
                "google/gemini-3.8-flash",
              ).name,
            ).toBe("openrouter");
            continue;
          }
          expect(() => createTanStackTextAdapterFactory(options)).toThrow(
            HandlerError,
          );
          expect(() => createTanStackTextAdapterFactory(options)).toThrow(
            "Managed AI is not available",
          );
          const resolved = Result.try({
            try: () => createTanStackTextAdapterFactory(options),
            catch: (error) => error,
          });
          expect(Result.isError(resolved)).toBe(true);
          if (Result.isError(resolved)) {
            expect(
              gradeFailure(
                readEvidence(resolved.error),
                failureSink({ event: "background-generation", expected: [] }),
              ).grade,
            ).toBe("anticipated");
          }
        }
      }
    } finally {
      env.USE_MOCK_AI = previousMock;
      env.OPENROUTER_API_KEY = previousKey;
    }
  });

  test.each(TANSTACK_AI_PROVIDERS)(
    "preserves %s credential-owned requests and applies managed public-corpus policy",
    async (provider) => {
      const previous = {
        USE_MOCK_AI: env.USE_MOCK_AI,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        BEDROCK_API_KEY: env.BEDROCK_API_KEY,
        GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY,
        MISTRAL_API_KEY: env.MISTRAL_API_KEY,
        OPENAI_API_KEY: env.OPENAI_API_KEY,
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      };
      const originalFetch = globalThis.fetch;
      const previousBedrockEndpoint =
        process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
      process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
        "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid";
      const apiKey = REQUEST_API_KEY;
      const requests: {
        url: string;
        body: unknown;
        authorization: string | null;
        contentType: string | null;
        apiKey: string | null;
      }[] = [];
      Object.assign(env, {
        USE_MOCK_AI: false,
        ANTHROPIC_API_KEY: apiKey,
        BEDROCK_API_KEY: apiKey,
        GOOGLE_GENERATIVE_AI_API_KEY: apiKey,
        MISTRAL_API_KEY: apiKey,
        OPENAI_API_KEY: apiKey,
        OPENROUTER_API_KEY: apiKey,
      });
      globalThis.fetch = Object.assign(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: RequestInit,
        ) => {
          const request =
            input instanceof Request
              ? input
              : new Request(input.toString(), init);
          requests.push({
            url: request.url,
            body: await request.json(),
            authorization: request.headers.get("authorization"),
            contentType: request.headers.get("content-type"),
            apiKey:
              request.headers.get("x-api-key") ??
              request.headers.get("x-goog-api-key"),
          });
          return new Response(
            JSON.stringify({
              error: { code: 400, message: "Request unavailable" },
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        },
        { preconnect: originalFetch.preconnect },
      );
      try {
        const model = DEFAULT_MODELS[provider].chat;
        const expected = ORIGINAL_REQUESTS[provider](model);
        const expectedRequest = {
          url: expected.url,
          body: expected.body,
          authorization: expected.authorization,
          contentType: "application/json",
          apiKey: expected.apiKey,
        };
        const chatOptions = {
          model,
          logger: resolveDebugOption(false),
          messages: [{ role: "user" as const, content: REQUEST_TEXT }],
          modelOptions: expected.modelOptions,
        };
        const baseline = createTanStackTextAdapterFactory({
          provider,
          dataClass: "public_corpus",
        })(model);
        for await (const _chunk of baseline.chatStream(chatOptions)) {
          /* consume stream */
        }
        expect(requests).toHaveLength(1);
        expect(requests.at(0)).toEqual(
          provider === "openrouter"
            ? {
                ...expectedRequest,
                url: "https://eu.openrouter.ai/api/v1/chat/completions",
                body: {
                  ...expected.body,
                  provider: { data_collection: "deny", zdr: true },
                },
              }
            : expectedRequest,
        );
        for (const dataClass of ["customer", "public_corpus"] as const) {
          requests.length = 0;
          const adapter = createTanStackTextAdapterFactory({
            provider,
            apiKey,
            dataClass,
          })(model);
          for await (const _chunk of adapter.chatStream(chatOptions)) {
            /* consume stream */
          }
          expect(requests).toHaveLength(1);
          expect(requests.at(0)).toEqual(expectedRequest);
        }
      } finally {
        globalThis.fetch = originalFetch;
        Object.assign(env, previous);
        if (previousBedrockEndpoint === undefined) {
          delete process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"];
        } else {
          process.env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] =
            previousBedrockEndpoint;
        }
      }
    },
  );

  test("rejects unsupported managed OpenRouter selections for every data class and residency", () => {
    const previousMock = env.USE_MOCK_AI;
    const previousKey = env.OPENROUTER_API_KEY;
    env.USE_MOCK_AI = false;
    env.OPENROUTER_API_KEY = "test-instance-key";
    try {
      for (const managedAIResidency of MANAGED_AI_RESIDENCIES) {
        for (const dataClass of ["customer", "public_corpus"] as const) {
          const policy =
            dataClass === "customer"
              ? { dataClass, managedAIResidency }
              : { dataClass };
          const factory = createTanStackTextAdapterFactory({
            provider: "openrouter",
            ...policy,
          });
          for (const modelId of [
            "openrouter/auto",
            "openrouter/auto:online",
            "google/gemini-3.8-flash:batch",
            "google/gemini-3.8-flash:online",
            "google/gemini-3.8-flash:online:free",
            "not/in-the-catalog",
            "gpt-4o-mini",
          ]) {
            const eligibility = assertManagedOpenRouterModel(modelId);
            expect(eligibility.isErr()).toBe(true);
            if (eligibility.isErr()) {
              expect(eligibility.error).toMatchObject({
                status: 503,
                code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
              });
            }
            for (const select of [
              () => factory(modelId),
              () =>
                getTanStackTextModelInfoById(
                  `openrouter::${modelId}`,
                  null,
                  "chat",
                  { dataClass, modelTier: MANAGED_MODEL_TIER.standard },
                ),
            ]) {
              const selection = Result.try({
                try: () => select(),
                catch: (error) => error,
              });
              expect(selection.isErr()).toBe(true);
              if (selection.isErr()) {
                expect(selection.error).toMatchObject({
                  status: 503,
                  code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                });
              }
            }
            const result = Result.try({
              try: () =>
                getTanStackTextModelById(`openrouter::${modelId}`, null, {
                  organizationId: null,
                  role: "chat",
                  ...policy,
                  modelTier: MANAGED_MODEL_TIER.standard,
                }),
              catch: (error) => error,
            });
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
              expect(result.error).toMatchObject({
                status: 503,
                code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
              });
            }
          }
          for (const model of BYOK_MODEL_OPTIONS.openrouter) {
            expect(assertManagedOpenRouterModel(model).isOk()).toBe(true);
            expect(factory(model).name).toBe("openrouter");
          }
        }
      }
    } finally {
      env.USE_MOCK_AI = previousMock;
      env.OPENROUTER_API_KEY = previousKey;
    }
  });

  test("rejects unsafe managed primary models before sending", async () => {
    const previousMock = env.USE_MOCK_AI;
    const previousKey = env.OPENROUTER_API_KEY;
    const originalFetch = globalThis.fetch;
    let sent = 0;
    env.USE_MOCK_AI = false;
    env.OPENROUTER_API_KEY = "test-instance-key";
    globalThis.fetch = Object.assign(
      async () => {
        sent += 1;
        return new Response(
          JSON.stringify({ error: { message: "Unexpected request" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      for (const managedAIResidency of MANAGED_AI_RESIDENCIES) {
        for (const dataClass of ["customer", "public_corpus"] as const) {
          const policy =
            dataClass === "customer"
              ? { dataClass, managedAIResidency }
              : { dataClass };
          const model = "google/gemini-3.8-flash";
          const adapter = createTanStackTextAdapterFactory({
            provider: "openrouter",
            ...policy,
          })(model);
          for (const invalidModel of [
            "openrouter/auto",
            `${model}:batch`,
            `${model}:online`,
            "not/in-the-catalog",
          ]) {
            const chatOptions = {
              model: invalidModel,
              messages: [{ role: "user" as const, content: REQUEST_TEXT }],
              logger: resolveDebugOption(false),
              modelOptions: {
                models: [model],
              },
            };
            const structuredOptions = {
              chatOptions,
              outputSchema: {
                type: "object",
                properties: { answer: { type: "string" } },
              },
            };
            const result = await Result.tryPromise({
              try: async () =>
                await adapter.structuredOutput(structuredOptions),
              catch: (error) => error,
            });
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
              expect(result.error).toMatchObject({
                code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                status: 503,
              });
            }
            for (const path of ["chat", "structured-stream"] as const) {
              const chunks: AdapterYieldChunk[] = [];
              const stream =
                path === "chat"
                  ? adapter.chatStream(chatOptions)
                  : adapter.structuredOutputStream?.(structuredOptions);
              if (!stream) {
                throw new HandlerError({
                  status: 500,
                  message: "Structured stream unavailable",
                });
              }
              for await (const chunk of stream) {
                chunks.push(chunk);
              }
              expect(chunks.map((chunk) => chunk.type)).toEqual([
                EventType.RUN_STARTED,
                EventType.RUN_ERROR,
              ]);
              expect(chunks.at(-1)).toMatchObject({
                type: EventType.RUN_ERROR,
                code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                error: { code: MANAGED_PROVIDER_UNAVAILABLE_CODE },
              });
            }
            expect(sent).toBe(0);
          }
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
      env.USE_MOCK_AI = previousMock;
      env.OPENROUTER_API_KEY = previousKey;
    }
  });

  const managedScenarios = {
    customer: MANAGED_AI_RESIDENCIES.map(
      (managedAIResidency) =>
        ({
          name: `managed-${managedAIResidency}`,
          options: { dataClass: "customer", managedAIResidency },
          host: `${managedAIResidency}.openrouter.ai`,
          strict: true,
        }) as const,
    ),
    public_corpus: MANAGED_AI_RESIDENCIES.map(
      (managedAIResidency) =>
        ({
          name: `managed-public-${managedAIResidency}`,
          options: { dataClass: "public_corpus", managedAIResidency },
          host: "eu.openrouter.ai",
          strict: true,
        }) as const,
    ),
  } satisfies Record<
    AIDataClass,
    readonly {
      name: string;
      options: AIRequestPolicy;
      host: string;
      strict: true;
    }[]
  >;

  for (const scenario of [
    {
      name: "byok-customer",
      options: { apiKey: "test-customer-key", dataClass: "customer" },
      host: "openrouter.ai",
      strict: false,
    },
    {
      name: "byok-public",
      options: { apiKey: "test-customer-key", dataClass: "public_corpus" },
      host: "openrouter.ai",
      strict: false,
    },
    ...Object.values(managedScenarios).flat(),
  ] as const) {
    for (const path of ["chat", "structured", "structured-stream"] as const) {
      for (const response of [
        { status: 400, message: "Request unavailable", routingRefusal: false },
        { status: 401, message: "Request unavailable", routingRefusal: false },
        { status: 403, message: "Request unavailable", routingRefusal: false },
        {
          status: 403,
          message: "No endpoints found supporting your data region.",
          metadata: { failed_routing_step: "Filter by Data Region" },
          routingRefusal: false,
        },
        { status: 404, message: "Request unavailable", routingRefusal: false },
        {
          status: 404,
          message: "No endpoints found for this model.",
          routingRefusal: false,
        },
        {
          status: 404,
          message: "No endpoints found supporting your data region.",
          metadata: {
            routing_funnel: [{ step: "Initial Endpoints", endpoint_count: 1 }],
            failed_routing_step: "Filter by Data Region",
          },
          routingRefusal: true,
        },
        {
          status: 404,
          message: "Region endpoint unavailable.",
          metadata: { failed_routing_step: "Filter by Data Region" },
          routingRefusal: true,
        },
        {
          status: 404,
          message: "No endpoints found supporting your data region.",
          routingRefusal: false,
        },
        {
          status: 404,
          message: "No endpoints found supporting your data region.",
          metadata: { failed_routing_step: "Filter by Data Policy" },
          routingRefusal: false,
        },
        {
          status: 404,
          message: "No endpoints found matching your data policy.",
          metadata: { failed_routing_step: "Filter by Data Policy" },
          routingRefusal: false,
        },
        { status: 429, message: "Request unavailable", routingRefusal: false },
        {
          status: "aborted",
          message: "Request unavailable",
          routingRefusal: false,
        },
      ] as const) {
        const { status, message, routingRefusal } = response;
        test(`applies ${scenario.name} request options on ${path} with status ${status} and routing ${routingRefusal}`, async () => {
          const originalFetch = globalThis.fetch;
          const previousMock = env.USE_MOCK_AI;
          const previousKey = env.OPENROUTER_API_KEY;
          const requests: { url: string; body: unknown }[] = [];
          env.USE_MOCK_AI = false;
          env.OPENROUTER_API_KEY = "test-instance-key";
          globalThis.fetch = Object.assign(
            async (
              input: Parameters<typeof globalThis.fetch>[0],
              init?: RequestInit,
            ) => {
              const request =
                input instanceof Request
                  ? input
                  : new Request(input.toString(), init);
              requests.push({ url: request.url, body: await request.json() });
              if (status === "aborted") {
                throw new DOMException("Request aborted", "AbortError");
              }
              return new Response(
                JSON.stringify({
                  error: {
                    code: status,
                    message,
                    ...("metadata" in response
                      ? { metadata: response.metadata }
                      : {}),
                  },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            },
            { preconnect: originalFetch.preconnect },
          );
          try {
            const model = scenario.strict
              ? "google/gemini-3.8-flash"
              : "google/gemini-3.8-flash:online";
            const adapter = createTanStackTextAdapterFactory({
              provider: "openrouter",
              ...scenario.options,
            })(model);
            const chatOptions = {
              model,
              logger: resolveDebugOption(false),
              messages: [{ role: "user" as const, content: "Reply with OK." }],
              modelOptions: {
                provider: { dataCollection: "allow" as const, zdr: false },
                plugins: [{ id: "web" as const }],
                variant: "online" as const,
                models: [model],
              },
            };
            const structuredOptions = {
              chatOptions,
              outputSchema: {
                type: "object",
                properties: { answer: { type: "string" } },
                required: ["answer"],
              },
            };
            const chunks: AdapterYieldChunk[] = [];
            const managedRefusal = scenario.strict && routingRefusal;
            switch (path) {
              case "chat":
                for await (const chunk of adapter.chatStream(chatOptions)) {
                  chunks.push(chunk);
                }
                break;
              case "structured": {
                const result = await Result.tryPromise({
                  try: async () =>
                    await adapter.structuredOutput(structuredOptions),
                  catch: (error) => error,
                });
                expect(Result.isError(result)).toBe(true);
                if (Result.isOk(result)) {
                  throw new HandlerError({
                    status: 500,
                    message: "Expected request failure",
                  });
                }
                if (managedRefusal) {
                  expect(HandlerError.is(result.error)).toBe(true);
                  expect(result.error).toMatchObject({
                    status: 503,
                    code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                  });
                } else if (status === "aborted") {
                  expect(result.error).toMatchObject({
                    name: "RequestAbortedError",
                  });
                } else {
                  expect(HandlerError.is(result.error)).toBe(false);
                  expect(readProviderStatus(result.error)?.status).toBe(status);
                }
                break;
              }
              case "structured-stream":
                if (!adapter.structuredOutputStream) {
                  throw new HandlerError({
                    status: 500,
                    message: "Structured stream unavailable",
                  });
                }
                for await (const chunk of adapter.structuredOutputStream(
                  structuredOptions,
                )) {
                  chunks.push(chunk);
                }
                break;
              default:
                path satisfies never;
            }
            if (path !== "structured") {
              const terminal = chunks.at(-1);
              expect(terminal?.type).toBe(EventType.RUN_ERROR);
              if (terminal?.type !== EventType.RUN_ERROR) {
                throw new HandlerError({
                  status: 500,
                  message: "Expected request failure",
                });
              }
              if (managedRefusal) {
                expect(terminal).toMatchObject({
                  code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
                  error: { code: MANAGED_PROVIDER_UNAVAILABLE_CODE },
                });
                expect(terminal.message).toContain(
                  "Managed AI is not available",
                );
                expect(terminal.rawEvent).toBeUndefined();
              } else if (status === "aborted") {
                expect(terminal.code).toBe("aborted");
              } else {
                expect(
                  readProviderStatus(terminal.rawEvent ?? terminal)?.status,
                ).toBe(status);
                expect(terminal.code).not.toBe(
                  MANAGED_PROVIDER_UNAVAILABLE_CODE,
                );
              }
            }
            expect(requests).toHaveLength(1);
            const request = requests.at(0);
            if (!request) {
              throw new HandlerError({
                status: 500,
                message: "Expected request",
              });
            }
            const format = providerWireFormatOf(new URL(request.url));
            expect(format).toBe("openai-chat");
            expect(
              findTranscriptProblems({
                format: "openai-chat",
                body: request.body,
              }),
            ).toEqual([]);
            expect(requests.at(0)?.url).toBe(
              `https://${scenario.host}/api/v1/chat/completions`,
            );
            expect(requests.at(0)?.body).toMatchObject({
              provider: scenario.strict
                ? { data_collection: "deny", zdr: true }
                : { data_collection: "allow", zdr: false },
            });
            expect(requests.at(0)?.body).toMatchObject({
              model: scenario.strict
                ? "google/gemini-3.8-flash"
                : `${model}:online`,
            });
            if (!("apiKey" in scenario.options)) {
              expect(requests.at(0)?.body).not.toHaveProperty("models");
            } else {
              expect(requests.at(0)?.body).toMatchObject({ models: [model] });
            }
            if (scenario.strict) {
              expect(requests.at(0)?.body).not.toHaveProperty("plugins");
            } else {
              expect(requests.at(0)?.body).toMatchObject({
                plugins: [{ id: "web" }],
              });
            }
          } finally {
            globalThis.fetch = originalFetch;
            env.USE_MOCK_AI = previousMock;
            env.OPENROUTER_API_KEY = previousKey;
          }
        });
      }
    }
  }
});
