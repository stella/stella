import { EventType } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { Result } from "better-result";
import { afterAll, describe, expect, spyOn, test } from "bun:test";

import type { TanStackAIProvider } from "@stll/ai-catalog";
import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { ProviderCallError } from "@/api/lib/errors/provider-call-error";
import { isTransientProviderFailure } from "@/api/lib/errors/provider-retry-policy";
import { withRecoveredProviderStatus } from "@/api/lib/tanstack-ai-generate";
import { createTanStackTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { isRecord } from "@/api/lib/type-guards";
import { SEAM_DRIVERS } from "@/api/tests/helpers/ai-text-call-sites";
import { cassetteForModel } from "@/api/tests/helpers/provider-request-matrix";
import {
  cassetteFor,
  loadProviderWireCassettes,
  PROVIDER_WIRE_PROVIDERS,
} from "@/api/tests/helpers/provider-wire-cassette";
import type { ProviderWireCassette } from "@/api/tests/helpers/provider-wire-cassette";
import {
  replayWireScenario,
  wireChatModel,
} from "@/api/tests/helpers/provider-wire-contract";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import type { ProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";

// Model requests are retried by the generation layer alone
// (`provider-retry-policy.ts`): every check it makes before a dispatch then
// sees every send. This census holds each provider client the API builds to
// one request per attempt, through the real model factory and the real
// adapter and SDK, with only `fetch` answered from the provider wire corpus.
// The corpus is keyed by the catalog's provider list, so a provider added
// there is held here before it can serve a request.

const cassettes = loadProviderWireCassettes();
const testState = createTestState({ file: import.meta.path, config: env });

let installed: ProviderWireReplay | undefined;
testState.beforeAll(() => {
  testState.setConfig("USE_MOCK_AI", false);
  // Were a Bedrock request ever to bypass `fetch`, it would go to a host
  // that does not resolve rather than to AWS.
  testState.setEnv(
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "https://bedrock-runtime.us-east-1.amazonaws.com.cassette.invalid",
  );
  // Stainless clients read `retry-after-ms`; 1 ms keeps a waited-out delay
  // short without leaving the hint out.
  installed = installProviderWireReplay({ retryAfterMs: 1 });
});
afterAll(() => {
  installed?.restore();
});

const replay = (): ProviderWireReplay => {
  if (installed === undefined) {
    throw new Error("The replay installs before any test runs");
  }
  return installed;
};

/** Failures every provider SDK retried before Stella turned that off. */
const SDK_RETRIED_SCENARIOS = ["rate-limit", "server-error"] as const;

/** The client builds the Stainless SDKs make their errors through
 *  `makeStatusError`, where the retry hints join the error. */
const HINTED_PROVIDERS: ReadonlySet<TanStackAIProvider> = new Set([
  "anthropic",
  "openai",
]);

const runErrorEvidence = (chunks: readonly unknown[]): unknown => {
  const failure = chunks.find(
    (chunk) => isRecord(chunk) && chunk["type"] === EventType.RUN_ERROR,
  );
  return isRecord(failure) ? failure["rawEvent"] : undefined;
};

describe("each provider client sends a failed request once", () => {
  for (const provider of PROVIDER_WIRE_PROVIDERS) {
    for (const scenario of SDK_RETRIED_SCENARIOS) {
      test(`${provider}: ${scenario}`, async () => {
        // The cassette answers every repeat of the request, so a client
        // that retried would be served and counted here.
        const cassette = cassetteFor(cassettes, provider, scenario);
        const { findings, requests, run } = await replayWireScenario({
          cassette,
          replay: replay(),
        });
        expect(requests).toBe(1);
        expect(findings.unexpected).toEqual([]);
        expect(run.overdue).toBe(false);
        const failed =
          run.thrown !== undefined ||
          run.chunks.some((chunk) => chunk.type === EventType.RUN_ERROR);
        expect(failed).toBe(true);
        if (HINTED_PROVIDERS.has(provider)) {
          // The retry hint survives TanStack's `RUN_ERROR` projection.
          expect(runErrorEvidence(run.chunks)).toMatchObject({
            headers: { "retry-after-ms": "1" },
          });
        }
      });
    }
  }
});

/**
 * The failure each provider's retry is shown with. Google's recorded rate
 * limit asks for twelve seconds, which the layer would wait out; its outage
 * is retried on the same path without the wait.
 */
const LAYER_RETRY_SCENARIO = {
  anthropic: "rate-limit",
  bedrock: "rate-limit",
  google: "server-error",
  mistral: "rate-limit",
  openai: "rate-limit",
  openrouter: "rate-limit",
} as const satisfies Record<
  TanStackAIProvider,
  (typeof SDK_RETRIED_SCENARIOS)[number]
>;

/** The provider's failure once, then its plain answer. */
const failureThenAnswer = (
  provider: TanStackAIProvider,
): ProviderWireCassette => {
  const answer = cassetteFor(cassettes, provider, "text");
  const failure = cassetteForModel(
    cassetteFor(cassettes, provider, LAYER_RETRY_SCENARIO[provider]),
    answer.model,
  );
  const [first] = failure.exchanges;
  if (first === undefined) {
    throw new Error(`${provider}: the failure cassette has an exchange`);
  }
  const { repeat: _repeat, ...once } = first;
  return { ...answer, exchanges: [once, ...answer.exchanges] };
};

describe("the generation layer retries what the clients no longer do", () => {
  for (const provider of PROVIDER_WIRE_PROVIDERS) {
    test(`${provider}: ${LAYER_RETRY_SCENARIO[provider]}, then the answer`, async () => {
      const cassette = failureThenAnswer(provider);
      const served = replay();
      served.serve(cassette);
      const { got, want } =
        await SEAM_DRIVERS["require-complete"].settle(cassette);
      const sent = served.requests().length;
      const findings = served.takeFindings();
      expect(got).toEqual(want);
      // One request per attempt: the failure, then the retry that answered.
      expect(sent).toBe(2);
      expect(findings).toEqual({ unconsumed: [], unexpected: [] });
    });
  }
});

/** Sends the first `failures` requests nowhere: `fetch` rejects as a
 *  connection the network dropped would, with `error`'s shape. The rest go
 *  to the replay. */
const failFirstRequests = (failures: number, error: () => Error) => {
  const answer = globalThis.fetch;
  let sent = 0;
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: RequestInit,
      ) => {
        sent += 1;
        if (sent <= failures) {
          throw error();
        }
        return await answer(input, init);
      },
      { preconnect: answer.preconnect },
    ),
  );
  return { restore: () => spy.mockRestore(), sent: () => sent };
};

const connectionReset = () =>
  Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" });
const connectionRefused = () =>
  Object.assign(new TypeError("Unable to connect"), {
    code: "ConnectionRefused",
  });

describe("a request that got no response is retried by the generation layer", () => {
  for (const [provider, failure] of [
    // Wrapped by its SDK as `APIConnectionError`.
    ["openai", connectionReset],
    ["anthropic", connectionReset],
    // Reaches the adapter as the runtime raised it.
    ["google", connectionRefused],
  ] as const) {
    test(`${provider}: a streamed run that failed before its first output`, async () => {
      const cassette = cassetteFor(cassettes, provider, "text");
      const served = replay();
      served.serve(cassette);
      const network = failFirstRequests(1, failure);
      try {
        const { got, want } =
          await SEAM_DRIVERS["require-complete"].settle(cassette);
        expect(got).toEqual(want);
        // The dropped request, then the retry that answered.
        expect(network.sent()).toBe(2);
        expect(served.takeFindings()).toEqual({
          unconsumed: [],
          unexpected: [],
        });
      } finally {
        network.restore();
      }
    });
  }

  test("openai: a structured request that failed is a transient provider failure", async () => {
    const network = failFirstRequests(
      Number.POSITIVE_INFINITY,
      connectionReset,
    );
    try {
      const model = wireChatModel("openai");
      const adapter = createTanStackTextAdapterFactory({
        apiKey: "cassette-replay-no-credentials",
        dataClass: "public_corpus",
        provider: "openai",
      })(model);
      const thrown = await rejectionOf(
        adapter.structuredOutput({
          chatOptions: {
            logger: resolveDebugOption(false),
            messages: [{ role: "user", content: "Fixture" }],
            model,
          },
          outputSchema: { type: "object", properties: {} },
        }),
      );
      // The client sent it once and raised its connection failure.
      expect(network.sent()).toBe(1);
      const recovered = withRecoveredProviderStatus({
        error: thrown,
        model: {
          adapter,
          keySource: "byok",
          modelId: model,
          modelOptions: {},
          provider: "openai",
        },
      });
      expect(recovered).toBeInstanceOf(ProviderCallError);
      expect(recovered).toMatchObject({ kind: "provider_unavailable" });
      expect(isTransientProviderFailure(recovered)).toBe(true);
    } finally {
      network.restore();
    }
  });
});

const CHECKPOINT_TOKEN = "Y2hlY2twb2ludA==";

/** A Google answer that stops at a checkpoint, as a long one does. */
const continuedAnswer = (text: string): string =>
  text.replace(
    '"finishReason":"STOP"',
    () =>
      `"finishReason":"CONTINUATION","continuationToken":"${CHECKPOINT_TOKEN}"`,
  );

/**
 * Google's streamed answer stopping at a checkpoint, then the answer a
 * continuation would get: it carries no token, so a client that continued
 * sends exactly one more request and stops, and the count shows it.
 */
const streamedCheckpointThenRest = (): ProviderWireCassette => {
  const text = cassetteFor(cassettes, "google", "text");
  const [exchange] = text.exchanges;
  if (exchange?.response.body.encoding !== "text") {
    throw new Error("The Google text cassette has a text answer");
  }
  const continued = continuedAnswer(exchange.response.body.text);
  expect(continued).not.toBe(exchange.response.body.text);
  const { repeat: _repeat, ...rest } = exchange;
  return {
    ...text,
    exchanges: [
      {
        ...rest,
        response: {
          ...exchange.response,
          body: { encoding: "text", text: continued },
        },
      },
      rest,
    ],
  };
};

/** The same for the unary API a structured request uses. */
const unaryCheckpointThenRest = (model: string) => {
  const answer = (candidate: Record<string, unknown>) => ({
    request: {
      method: "POST" as const,
      path: `/v1beta/models/${model}:generateContent`,
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        encoding: "text" as const,
        text: JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "{}" }], role: "model" },
              index: 0,
              ...candidate,
            },
          ],
        }),
      },
    },
  });
  return {
    model,
    exchanges: [
      answer({
        finishReason: "CONTINUATION",
        continuationToken: CHECKPOINT_TOKEN,
      }),
      answer({ finishReason: "STOP" }),
    ],
  };
};

const googleAdapter = (model: string) =>
  createTanStackTextAdapterFactory({
    apiKey: "cassette-replay-no-credentials",
    dataClass: "public_corpus",
    provider: "google",
  })(model);

const fixtureChatOptions = (model: string) => ({
  logger: resolveDebugOption(false),
  messages: [{ role: "user" as const, content: "Fixture" }],
  model,
});

const drain = async (stream: AsyncIterable<unknown> | undefined) => {
  if (stream === undefined) {
    throw new Error("The Google adapter streams structured output");
  }
  for await (const _chunk of stream) {
    // The run ends at the checkpoint.
  }
};

describe("Google answers that stop at a continuation checkpoint are not continued", () => {
  test("a streamed run sends its request once", async () => {
    const cassette = streamedCheckpointThenRest();
    const served = replay();
    served.serve(cassette);
    const adapter = googleAdapter(cassette.model);
    await drain(adapter.chatStream(fixtureChatOptions(cassette.model)));
    expect(served.requests()).toHaveLength(1);
    served.takeFindings();
  });

  test("a streamed structured request sends its request once", async () => {
    const cassette = streamedCheckpointThenRest();
    const served = replay();
    served.serve(cassette);
    const adapter = googleAdapter(cassette.model);
    await Result.tryPromise({
      try: async () =>
        await drain(
          adapter.structuredOutputStream?.({
            chatOptions: fixtureChatOptions(cassette.model),
            outputSchema: { type: "object", properties: {} },
          }),
        ),
      // The text answer is not the object the schema asks for; only the
      // request count is read here.
      catch: (error: unknown) => error,
    });
    expect(served.requests()).toHaveLength(1);
    served.takeFindings();
  });

  test("a structured request sends its request once", async () => {
    const model = cassetteFor(cassettes, "google", "text").model;
    const served = replay();
    served.serve(unaryCheckpointThenRest(model));
    await googleAdapter(model).structuredOutput({
      chatOptions: fixtureChatOptions(model),
      outputSchema: { type: "object", properties: {} },
    });
    expect(served.requests()).toHaveLength(1);
    served.takeFindings();
  });
});
