import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { createAnthropicChatWithClient } from "@tanstack/ai-anthropic";
import type { AnthropicMessagesClient } from "@tanstack/ai-anthropic";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { CachingDecision } from "@/api/lib/ai-config";
import {
  generateTanStackTextForRole,
  streamTanStackObjectForRole,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";

// Real `chat()` runtime, no module mocks. `generateTanStackTextForRole`
// compensates for the chat loop leaving a cancelled provider stream silently
// (a plain `break`, no terminal event, nothing thrown). That shape belongs to
// the SDK, so it is exercised here through the SDK itself: a change to its
// cancellation ordering or terminal events fails this file, not a caller.

const noCaching = {
  enabled: false,
  reason: "org-disabled",
} satisfies CachingDecision;
const TEST_OUTPUT_CEILING_TOKENS = 16;

type CancellationPoint = "mid-stream" | "after-finish";

const createCancellingAdapter = (
  controller: AbortController,
  cancelAt: CancellationPoint,
): AnyTextAdapter => ({
  kind: "text",
  name: "cancelling",
  model: "cancelling",
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ runId, threadId }) {
    const resolvedRunId = runId ?? "run-1";
    const resolvedThreadId = threadId ?? "thread-1";
    const messageId = "provider-message-1";
    yield {
      type: EventType.RUN_STARTED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
    } satisfies StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    } satisfies StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: "half an",
    } satisfies StreamChunk;
    if (cancelAt === "mid-stream") {
      controller.abort();
    }
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: " answer",
    } satisfies StreamChunk;
    yield { type: EventType.TEXT_MESSAGE_END, messageId } satisfies StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      finishReason: "stop",
      runId: resolvedRunId,
      threadId: resolvedThreadId,
    } satisfies StreamChunk;
    if (cancelAt === "after-finish") {
      controller.abort();
    }
  },
  structuredOutput: () => {
    throw new Error("Structured output is not part of this fixture");
  },
});

const createAnthropicOutputCeilingStream = async function* () {
  yield {
    type: "message_start",
    message: {
      id: "provider-message-1",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-6",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };
  yield {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: null },
  };
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "as far as it got", citations: null },
  };
  yield { type: "content_block_stop", index: 0 };
  yield {
    type: "message_delta",
    delta: { stop_reason: "max_tokens", stop_sequence: null },
    usage: { input_tokens: 10, output_tokens: 4 },
  };
  yield { type: "message_stop" };
};

const anthropicClient = {
  beta: {
    messages: {
      create: async () => createAnthropicOutputCeilingStream(),
    },
  },
} satisfies AnthropicMessagesClient;

const outputCeilingModel = {
  // The injected transport removes network nondeterminism; the installed
  // Anthropic adapter still maps provider events into TanStack lifecycle events.
  adapter: createAnthropicChatWithClient("claude-sonnet-4-6", anthropicClient),
  keySource: "instance",
  modelId: "claude-sonnet-4-6",
  modelOptions: {},
  provider: "anthropic",
} as ResolvedTanStackTextModel;

type FinishPolicy = "allow-incomplete" | "require-complete";

const generateAtOutputCeiling = async ({
  finishPolicy,
  terminalEvents,
}: {
  finishPolicy: FinishPolicy;
  terminalEvents: string[];
}) =>
  await generateTanStackTextForRole({
    analytics: {
      captureError: () => undefined,
      middleware: {
        onError: () => {
          terminalEvents.push("error");
        },
        onFinish: (_context, { finishReason }) => {
          terminalEvents.push(`finish:${finishReason ?? "unknown"}`);
        },
      },
    },
    caching: noCaching,
    finishPolicy,
    maxOutputTokens: TEST_OUTPUT_CEILING_TOKENS,
    organizationId: null,
    orgAIConfig: null,
    prompt: "Rewrite it.",
    resolveTextModel: () => outputCeilingModel,
    role: "chat",
    serviceTier: "standard",
    tenantWorkspaceIds: [],
  });

const generateWithCancellation = async (cancelAt: CancellationPoint) => {
  const controller = new AbortController();
  // SAFETY: the adapter is the only part of the resolved model the real chat
  // loop reads on this path; the rest is bookkeeping this canary never routes
  // through a provider.
  const model = {
    adapter: createCancellingAdapter(controller, cancelAt),
    keySource: "instance",
    modelId: "cancelling",
    modelOptions: {},
    provider: "openai",
  } as ResolvedTanStackTextModel;

  return await generateTanStackTextForRole({
    abortSignal: controller.signal,
    caching: noCaching,
    finishPolicy: "allow-incomplete",
    organizationId: null,
    orgAIConfig: null,
    prompt: "Rewrite it.",
    resolveTextModel: () => model,
    role: "chat",
    serviceTier: "standard",
    tenantWorkspaceIds: [],
  });
};

describe("TanStack cancellation canary", () => {
  test("a run cancelled mid-stream rejects instead of returning its prefix", async () => {
    const caught = await generateWithCancellation("mid-stream").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ status: 502 });
  });

  test("a run that finished before the cancellation keeps its output", async () => {
    expect(await generateWithCancellation("after-finish")).toBe(
      "half an answer",
    );
  });
});

describe("TanStack output-ceiling canary", () => {
  test("returns partial text through a real chat run and finishes middleware at length", async () => {
    const terminalEvents: string[] = [];

    expect(
      await generateAtOutputCeiling({
        finishPolicy: "allow-incomplete",
        terminalEvents,
      }),
    ).toBe("as far as it got");
    expect(terminalEvents).toEqual(["finish:length"]);
  });

  test("lets a complete-output caller reject the same length finish", async () => {
    const terminalEvents: string[] = [];

    const failure = await generateAtOutputCeiling({
      finishPolicy: "require-complete",
      terminalEvents,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ status: 502 });
    expect(terminalEvents).toEqual(["finish:length"]);
  });

  test("keeps a truncated structured-output run as an error", async () => {
    const drain = async () => {
      for await (const _event of streamTanStackObjectForRole({
        caching: noCaching,
        maxOutputTokens: TEST_OUTPUT_CEILING_TOKENS,
        organizationId: null,
        orgAIConfig: null,
        outputSchema: v.strictObject({ answer: v.string() }),
        prompt: "Extract the answer.",
        resolveTextModel: () => outputCeilingModel,
        role: "pdf",
        serviceTier: "standard",
        tenantWorkspaceIds: [],
      })) {
        continue;
      }
    };

    const failure = await drain().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "max_tokens", status: 502 });
  });
});
