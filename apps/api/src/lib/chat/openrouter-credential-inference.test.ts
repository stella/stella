import { STSClient } from "@aws-sdk/client-sts";
import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { DEFAULT_MODELS } from "@stll/ai-catalog";

import { env } from "@/api/env";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { createManagedProviderAvailability } from "@/api/lib/chat/managed-provider-availability";
import { createManagedOpenRouterCredentialProvider } from "@/api/lib/chat/openrouter-credential";
import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import { readProviderStatus } from "@/api/lib/observability/failure-evidence";
import {
  setMetricLineSinkForTesting,
  resetMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";
import { resolveTanStackTextModel } from "@/api/lib/tanstack-ai-generate";
import { createTanStackTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const MODEL = DEFAULT_MODELS.openrouter.chat;
const POLICY_ID = "credential-inference-fixture";
const AUDIENCE = "https://openrouter.ai";
const REGION = "eu-west-1";
const FIRST_TOKEN = "fixture-first-openrouter-token";
const NEXT_TOKEN = "fixture-next-openrouter-token";
const JWT = "fixture.sts.jwt";
const START = Date.parse("2028-04-05T12:00:00.000Z");

type StsRequestHandler = STSClient["config"]["requestHandler"];
type StsHttpResponse = Awaited<
  ReturnType<StsRequestHandler["handle"]>
>["response"];
type RequestPath = "chat" | "structured" | "structured-stream";
type FactoryPolicy =
  | { dataClass: "customer"; managedAIResidency: ManagedAIResidency }
  | { dataClass: "public_corpus" };

let previousEnv = {
  AI_PROVIDER: env.AI_PROVIDER,
  FEATURE_MANAGED_PROVIDER_CHECKS: env.FEATURE_MANAGED_PROVIDER_CHECKS,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  OPENROUTER_WIF_AUDIENCE: env.OPENROUTER_WIF_AUDIENCE,
  OPENROUTER_WIF_POLICY_ID: env.OPENROUTER_WIF_POLICY_ID,
  OPENROUTER_WIF_STS_REGION: env.OPENROUTER_WIF_STS_REGION,
  REQUIRE_PERSONAL_AI_KEY: env.REQUIRE_PERSONAL_AI_KEY,
  USE_MOCK_AI: env.USE_MOCK_AI,
};

beforeEach(() => {
  previousEnv = {
    AI_PROVIDER: env.AI_PROVIDER,
    FEATURE_MANAGED_PROVIDER_CHECKS: env.FEATURE_MANAGED_PROVIDER_CHECKS,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    OPENROUTER_WIF_AUDIENCE: env.OPENROUTER_WIF_AUDIENCE,
    OPENROUTER_WIF_POLICY_ID: env.OPENROUTER_WIF_POLICY_ID,
    OPENROUTER_WIF_STS_REGION: env.OPENROUTER_WIF_STS_REGION,
    REQUIRE_PERSONAL_AI_KEY: env.REQUIRE_PERSONAL_AI_KEY,
    USE_MOCK_AI: env.USE_MOCK_AI,
  };
});

afterEach(() => {
  Object.assign(env, previousEnv);
  resetMetricLineSinkForTesting();
});

const createCredentialProvider = () => {
  let exchangeCalls = 0;
  let stsCalls = 0;
  const provider = createManagedOpenRouterCredentialProvider({
    configuration: () => ({
      type: "federated",
      policyId: POLICY_ID,
      audience: AUDIENCE,
      region: REGION,
    }),
    createStsClient: (region) => {
      stsCalls++;
      const requestHandler: StsRequestHandler = {
        handle: async () => ({
          response: {
            statusCode: 200,
            headers: { "content-type": "text/xml" },
            body: new TextEncoder().encode(
              `<GetWebIdentityTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetWebIdentityTokenResult><WebIdentityToken>${JWT}</WebIdentityToken><Expiration>${new Date(START + 900_000).toISOString()}</Expiration></GetWebIdentityTokenResult></GetWebIdentityTokenResponse>`,
            ),
          } satisfies StsHttpResponse,
        }),
        destroy: () => undefined,
      };
      return new STSClient({
        region,
        maxAttempts: 1,
        credentials: {
          accessKeyId: "fixture-access",
          secretAccessKey: "fixture-secret",
        },
        requestHandler,
      });
    },
    fetchExchange: async () => {
      exchangeCalls++;
      return Response.json({
        access_token: exchangeCalls === 1 ? FIRST_TOKEN : NEXT_TOKEN,
        token_type: "Bearer",
        expires_in: 900,
      });
    },
    now: () => START,
    monotonicNow: () => 0,
  });
  return {
    provider,
    get exchangeCalls() {
      return exchangeCalls;
    },
    get stsCalls() {
      return stsCalls;
    },
  };
};

test("catalog 401 invalidates the matching federated token and refreshes with a new token", async () => {
  installRecordingLogger();
  setMetricLineSinkForTesting(() => undefined);
  const harness = createCredentialProvider();
  const tokens: string[] = [];
  const monitor = createManagedProviderAvailability({
    getCredential: async () =>
      (await harness.provider.get()).map((apiKey) => ({
        type: "federated" as const,
        apiKey,
        invalidate: () => harness.provider.invalidate(apiKey),
      })),
    intervalMs: 1000,
    timeoutMs: 5000,
    now: () => START,
    fetchCatalog: async (_url, init) => {
      const authorization = new Headers(init.headers).get("Authorization");
      if (authorization !== null) {
        tokens.push(authorization);
      }
      return authorization === `Bearer ${FIRST_TOKEN}`
        ? new Response(null, { status: 401 })
        : Response.json({ data: [{ id: MODEL }] });
    },
  });
  expect((await monitor.refresh()).every((result) => result.isErr())).toBe(
    true,
  );
  expect(harness.exchangeCalls).toBe(1);
  expect(monitor.check(MODEL, "eu").isErr()).toBe(true);
  expect(monitor.check(MODEL, "us").isErr()).toBe(true);
  expect((await monitor.refresh()).every((result) => result.isOk())).toBe(true);
  expect(harness.exchangeCalls).toBe(2);
  expect(tokens).toEqual([
    `Bearer ${FIRST_TOKEN}`,
    `Bearer ${FIRST_TOKEN}`,
    `Bearer ${NEXT_TOKEN}`,
    `Bearer ${NEXT_TOKEN}`,
  ]);
  expect(monitor.check(MODEL, "eu").isOk()).toBe(true);
  expect(monitor.check(MODEL, "us").isOk()).toBe(true);
});

const outputSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

const readFailure = async (adapter: AnyTextAdapter, path: RequestPath) => {
  const chatOptions = {
    model: MODEL,
    messages: [{ role: "user" as const, content: "fixture request" }],
    logger: resolveDebugOption(false),
  };
  const structuredOptions = { chatOptions, outputSchema };
  if (path === "structured") {
    const result = await Result.tryPromise({
      try: async () => await adapter.structuredOutput(structuredOptions),
      catch: (error) => error,
    });
    return { type: "structured" as const, result };
  }
  const result = await Result.tryPromise({
    try: async () => {
      const chunks = [];
      const stream =
        path === "chat"
          ? adapter.chatStream(chatOptions)
          : adapter.structuredOutputStream?.(structuredOptions);
      if (stream === undefined) {
        throw new Error("Adapter did not provide structured output streaming");
      }
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return chunks.at(-1);
    },
    catch: (error) => error,
  });
  return { type: "stream" as const, result };
};

const install401Fetch = () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: URL; authorization: string | null }[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      requests.push({
        url: new URL(request.url),
        authorization: request.headers.get("authorization"),
      });
      return Response.json(
        { error: { code: 401, message: "fixture unauthorized" } },
        { status: 401 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const managedPolicy = (residency: ManagedAIResidency): FactoryPolicy => ({
  dataClass: "customer",
  managedAIResidency: residency,
});

const runFederated401 = async (
  policy: FactoryPolicy,
  path: RequestPath,
  assertRoute: (url: URL) => void,
) => {
  const providerState = createCredentialProvider();
  const fetch = install401Fetch();
  try {
    const resolved = await resolveTanStackTextModel(
      {
        modelId: MODEL,
        organizationId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
        orgAIConfig: undefined,
        reasoningEffort: undefined,
        role: "chat",
        ...policy,
      },
      providerState.provider,
    );
    expect(resolved.provider).toBe("openrouter");
    const result = await readFailure(resolved.adapter, path);
    if (path === "structured") {
      if (result.type !== "structured") {
        throw new Error("Expected a structured-output result");
      }
      expect(result.result.isErr()).toBe(true);
      if (Result.isError(result.result)) {
        expect(result.result.error).toMatchObject({
          status: 503,
          code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
        });
      }
    } else {
      if (result.type !== "stream") {
        throw new Error("Expected a stream result");
      }
      expect(result.result.isOk()).toBe(true);
      if (Result.isOk(result.result)) {
        expect(result.result.value).toMatchObject({
          type: EventType.RUN_ERROR,
          code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
        });
      }
    }
    expect(fetch.requests).toHaveLength(1);
    const request = fetch.requests.at(0);
    assertRoute(request?.url ?? new URL("https://invalid.example"));
    expect(request?.authorization).toBe(`Bearer ${FIRST_TOKEN}`);

    const refreshed = await providerState.provider.get();
    expect(refreshed).toEqual(Result.ok(NEXT_TOKEN));
    expect(providerState.exchangeCalls).toBe(2);
    expect(providerState.stsCalls).toBe(2);
  } finally {
    fetch.restore();
  }
};

describe("federated OpenRouter 401 recovery at the inference boundary", () => {
  test("maps customer eu/us and public-corpus 401s for chat and structured paths", async () => {
    env.FEATURE_MANAGED_PROVIDER_CHECKS = false;
    env.OPENROUTER_API_KEY = undefined;
    env.USE_MOCK_AI = false;
    env.AI_PROVIDER = "openrouter";
    env.REQUIRE_PERSONAL_AI_KEY = false;
    env.OPENROUTER_WIF_POLICY_ID = POLICY_ID;
    env.OPENROUTER_WIF_AUDIENCE = AUDIENCE;
    env.OPENROUTER_WIF_STS_REGION = REGION;
    const logger = installRecordingLogger();
    const metricLines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      metricLines.push(line);
    });
    try {
      for (const { policy, host } of [
        { policy: managedPolicy("eu"), host: "eu.openrouter.ai" },
        { policy: managedPolicy("us"), host: "us.openrouter.ai" },
        {
          policy: { dataClass: "public_corpus" } as const,
          host: "eu.openrouter.ai",
        },
      ]) {
        for (const path of [
          "chat",
          "structured",
          "structured-stream",
        ] as const) {
          await runFederated401(policy, path, (url) => {
            expect(url.hostname).toBe(host);
            expect(url.pathname).toBe("/api/v1/chat/completions");
          });
        }
      }
      const telemetry = JSON.stringify({ logs: logger.records, metricLines });
      expect(telemetry).not.toContain(JWT);
      expect(telemetry).not.toContain(FIRST_TOKEN);
      expect(telemetry).not.toContain(NEXT_TOKEN);
      const metricSchema = v.object({
        _aws: v.object({
          CloudWatchMetrics: v.array(
            v.object({
              Dimensions: v.array(v.array(v.string())),
            }),
          ),
        }),
      });
      const dimensions = metricLines.flatMap((line) =>
        v
          .parse(metricSchema, JSON.parse(line))
          ._aws.CloudWatchMetrics.map((metric) => metric.Dimensions),
      );
      expect(dimensions.length).toBeGreaterThan(0);
      expect(
        dimensions.every((value) =>
          value.every(
            (dimension) =>
              JSON.stringify(dimension) === JSON.stringify(["outcome"]) ||
              dimension.length === 0,
          ),
        ),
      ).toBe(true);
    } finally {
      logger.restore();
    }
  });

  test("preserves static and BYOK 401s without invalidating a cached token", async () => {
    env.FEATURE_MANAGED_PROVIDER_CHECKS = false;
    env.OPENROUTER_API_KEY = undefined;
    env.USE_MOCK_AI = false;
    env.AI_PROVIDER = "openrouter";
    env.REQUIRE_PERSONAL_AI_KEY = false;
    const providerState = createCredentialProvider();
    const first = await providerState.provider.get();
    expect(Result.isOk(first)).toBe(true);
    if (Result.isError(first)) {
      throw first.error;
    }
    const fetch = install401Fetch();
    try {
      for (const scenario of [
        {
          type: "static",
          credential: { type: "static", apiKey: first.value } as const,
        },
        { type: "byok" },
      ] as const) {
        const options =
          scenario.type === "byok"
            ? {
                provider: "openrouter" as const,
                apiKey: "fixture-byok-key",
                dataClass: "public_corpus" as const,
              }
            : {
                provider: "openrouter" as const,
                managedOpenRouterCredential: scenario.credential,
                ...managedPolicy("eu"),
              };
        const adapter = createTanStackTextAdapterFactory(options)(MODEL);
        const result = await readFailure(adapter, "chat");
        if (result.type !== "stream") {
          throw new Error("Expected a stream result");
        }
        expect(result.result.isOk()).toBe(true);
        if (Result.isOk(result.result)) {
          expect(result.result.value).toMatchObject({
            type: EventType.RUN_ERROR,
          });
          expect(result.result.value).not.toMatchObject({
            code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
          });
          expect(
            result.result.value?.type === EventType.RUN_ERROR
              ? readProviderStatus(
                  result.result.value.rawEvent ?? result.result.value,
                )?.status
              : undefined,
          ).toBe(401);
        }
      }
      expect(fetch.requests).toHaveLength(2);
      expect(fetch.requests.map(({ authorization }) => authorization)).toEqual([
        `Bearer ${FIRST_TOKEN}`,
        "Bearer fixture-byok-key",
      ]);
      expect(await providerState.provider.get()).toEqual(
        Result.ok(first.value),
      );
      expect(providerState.exchangeCalls).toBe(1);
    } finally {
      fetch.restore();
    }
  });
});
