import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { type AnyTextAdapter, EventType, type StreamChunk } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { BedrockConverseTextAdapter } from "@tanstack/ai-bedrock";
import { afterEach, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { computeRawUsageMicroUnits } from "@/api/lib/usage/unit-model";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  SERVER_ANALYTICS_EVENTS,
  type ServerAnalytics,
} from "./server-analytics";
import { createTanStackAIAnalyticsCallbacks } from "./tanstack-ai";

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const UNCACHED_INPUT = 217;
const CACHE_READ = 45_082;
const CACHE_WRITE = 1204;
const OUTPUT = 1538;
const TOTAL_INPUT = UNCACHED_INPUT + CACHE_READ + CACHE_WRITE;

const anthropicFetch: typeof fetch = Object.assign(
  async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "cache-usage-message",
          type: "message",
          role: "assistant",
          model: ANTHROPIC_MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: UNCACHED_INPUT,
            cache_read_input_tokens: CACHE_READ,
            cache_creation_input_tokens: CACHE_WRITE,
            output_tokens: 0,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Done." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: OUTPUT },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
  { preconnect: globalThis.fetch.preconnect },
);

// Only the AWS transport is replaced. The real Converse parser, usage builder,
// chat engine, analytics middleware and ledger conversion run below.
class CachedBedrockAdapter extends BedrockConverseTextAdapter<
  typeof BEDROCK_MODEL
> {
  protected override async sendStream() {
    return (async function* (): AsyncGenerator<ConverseStreamOutput> {
      yield { messageStart: { role: "assistant" } };
      yield {
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Done." } },
      };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: "end_turn" } };
      yield {
        metadata: {
          usage: {
            inputTokens: UNCACHED_INPUT,
            outputTokens: OUTPUT,
            totalTokens: TOTAL_INPUT + OUTPUT,
            cacheReadInputTokens: CACHE_READ,
            cacheWriteInputTokens: CACHE_WRITE,
          },
          metrics: { latencyMs: 1 },
        },
      };
    })();
  }
}

afterEach(resetMetricLineSinkForTesting);

const recordedMetering = (
  provider: "anthropic" | "bedrock" | "openai",
  modelId: string,
) => {
  const workspaceId = toSafeId<"workspace">("workspace_cache_usage");
  const insertedRows: unknown[] = [];
  const ledgerKeys = new Set<string>();
  const metricLines: string[] = [];
  const events: Parameters<ServerAnalytics["capture"]>[0][] = [];
  setMetricLineSinkForTesting((line) => {
    metricLines.push(line);
  });
  const { safeDb } = createScopedDbMock({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
              currentPeriodStart: new Date("2026-06-01T00:00:00.000Z"),
              status: "active",
            },
          ],
          for: async () => [{ id: workspaceId }],
        }),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        if (
          typeof values !== "object" ||
          values === null ||
          !("idempotencyKey" in values) ||
          typeof values.idempotencyKey !== "string"
        ) {
          throw new TypeError("Expected a keyed usage event");
        }
        const duplicate = ledgerKeys.has(values.idempotencyKey);
        ledgerKeys.add(values.idempotencyKey);
        if (!duplicate) {
          insertedRows.push(values);
        }
        return {
          onConflictDoNothing: () => ({
            returning: async () =>
              duplicate ? [] : [{ id: "cache_usage_event" }],
          }),
        };
      },
    }),
  });
  const callbacks = createTanStackAIAnalyticsCallbacks({
    modelTier: MANAGED_MODEL_TIER.standard,
    dataClass: "public_corpus",
    analytics: {
      capture: (event) => {
        events.push(event);
      },
      flush: async () => undefined,
      identifyOrganizationGroup: () => undefined,
    },
    feature: "chat.stream",
    traceId: `cache-usage-${provider}`,
    promptCacheSurface: "chat",
    usageMetering: {
      actionType: "chat",
      organizationId: toSafeId<"organization">("org_cache_usage"),
      safeDb,
      serviceTier: "standard",
      userId: toSafeId<"user">("user_cache_usage"),
      workspaceId,
    },
  }).forModel({ provider, modelId, keySource: "byok" });
  return { callbacks, insertedRows, metricLines, ledgerKeys, events };
};

test.each(["anthropic", "bedrock"] as const)(
  "%s adapter cache usage is metered once and preserves the cache-hit denominator",
  async (provider) => {
    const adapter =
      provider === "anthropic"
        ? createAnthropicChat(ANTHROPIC_MODEL, "test-cache-key", {
            fetch: anthropicFetch,
          })
        : new CachedBedrockAdapter({ apiKey: "test-cache-key" }, BEDROCK_MODEL);
    const { callbacks, insertedRows, metricLines } = recordedMetering(
      provider,
      adapter.model,
    );
    const errors: unknown[] = [];
    for await (const chunk of streamChatChunks({
      threadId: `cache-usage-${provider}`,
      adapter,
      messages: [{ role: "user", content: "Reply." }],
      middleware: [callbacks.middleware],
    })) {
      if (chunk.type === EventType.RUN_ERROR) {
        errors.push(chunk);
      }
    }

    expect(errors).toEqual([]);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      isByok: true,
      rawUsageMicroUnits: computeRawUsageMicroUnits({
        modelId: adapter.model,
        uncachedInputTokens: UNCACHED_INPUT,
        cacheReadTokens: CACHE_READ,
        cacheWriteTokens: CACHE_WRITE,
        outputTokens: OUTPUT,
      }),
    });
    expect(metricLines.map((line): unknown => JSON.parse(line))).toMatchObject([
      {
        PromptCachedInputTokens: CACHE_READ,
        PromptInputTokens: TOTAL_INPUT,
        provider,
        surface: "chat",
      },
    ]);
  },
);

test("SDK retries meter each reported provider call even when the iteration stays the same", async () => {
  const { callbacks, insertedRows, metricLines, ledgerKeys, events } =
    recordedMetering("openai", "gpt-5.4-mini");
  const reported = { promptTokens: 24, completionTokens: 2, totalTokens: 26 };
  const iterations: number[] = [];
  const terminals: string[] = [];
  let calls = 0;
  const adapter = {
    kind: "text",
    name: "retried-usage",
    model: "gpt-5.4-mini",
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    async *chatStream({ runId, threadId }) {
      calls += 1;
      const identity = {
        runId: runId ?? "retry-run",
        threadId,
      };
      yield { type: EventType.RUN_STARTED, ...identity } satisfies StreamChunk;
      if (calls === 1) {
        yield {
          type: EventType.RUN_ERROR,
          message: "Rate limited after reporting usage.",
          code: "rate_limit",
          retryAfterMs: 0,
          usage: reported,
        } satisfies StreamChunk;
        return;
      }
      yield {
        type: EventType.RUN_FINISHED,
        ...identity,
        finishReason: "stop",
        usage: reported,
      } satisfies StreamChunk;
    },
    structuredOutput: () => {
      throw new Error("This run streams");
    },
  } satisfies AnyTextAdapter;
  const errors: unknown[] = [];
  for await (const chunk of streamChatChunks({
    threadId: "retry-usage-thread",
    adapter,
    retry: { maxRetries: 1 },
    messages: [{ role: "user", content: "Reply." }],
    middleware: [
      callbacks.middleware,
      {
        onUsage: (ctx) => {
          iterations.push(ctx.iteration);
        },
        onChunk: (_ctx, observedChunk) => {
          if (
            observedChunk.type === EventType.RUN_ERROR ||
            observedChunk.type === EventType.RUN_FINISHED
          ) {
            terminals.push(observedChunk.type);
          }
        },
      },
    ],
  })) {
    if (chunk.type === EventType.RUN_ERROR) {
      errors.push(chunk);
    }
  }
  expect(errors).toEqual([]);
  expect(calls).toBe(2);
  expect(ledgerKeys.size).toBe(2);
  expect(iterations).toEqual([0, 0]);
  // The SDK consumes the retryable error before onChunk; only its usage and
  // the eventual successful terminal reach these middleware callbacks.
  expect(terminals).toEqual([EventType.RUN_FINISHED]);
  const generations = events.filter(
    (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGeneration,
  );
  expect(generations).toHaveLength(2);
  expect(generations.at(-1)?.properties).toMatchObject({
    $ai_input_tokens: reported.promptTokens,
    $ai_output_tokens: reported.completionTokens,
  });
  expect(generations.at(-1)?.properties).not.toHaveProperty("$ai_is_error");
  expect(insertedRows).toHaveLength(2);
  for (const row of insertedRows) {
    expect(row).toMatchObject({
      rawUsageMicroUnits: computeRawUsageMicroUnits({
        modelId: adapter.model,
        uncachedInputTokens: reported.promptTokens,
        outputTokens: reported.completionTokens,
      }),
    });
  }
  expect(metricLines).toHaveLength(2);
});
