import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import type { CachingDecision } from "@/api/lib/ai-config";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
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
