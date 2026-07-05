import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk, TokenUsage } from "@tanstack/ai";

import { isMockAI } from "@/api/consts";
import { registerTanStackMockTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { generateBatchMock } from "@/api/lib/workflow/generate-batch-mock";
import { registerBatchGenerator } from "@/api/lib/workflow/generate-batch-provider";

// Dev/test-only preload: wired via the api `dev` script's `--preload`, never
// imported from `src/index.ts`. Registering the faker-backed mock generator here
// (rather than referencing it from the production handlers) keeps
// `generate-batch-mock` and `@faker-js/faker` out of the production build — both
// the compiled binary and the knip `--production` graph.

const MOCK_REPLY =
  "Mock assistant reply: streaming is stubbed because USE_MOCK_AI is set.";

const mockUsage: TokenUsage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};

const createMockTextAdapter = (modelId: string): AnyTextAdapter => ({
  kind: "text",
  name: "mock",
  model: modelId,
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ model, runId, threadId }) {
    const resolvedRunId = runId ?? "mock-run";
    const resolvedThreadId = threadId ?? "mock-thread";
    const messageId = "mock-message";
    const timestamp = Date.now();

    yield {
      type: EventType.RUN_STARTED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      model,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      model,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: MOCK_REPLY,
      model,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
      model,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      model,
      timestamp,
      finishReason: "stop",
      usage: mockUsage,
    } satisfies StreamChunk;
  },
  structuredOutput: async ({ outputSchema }) => {
    await Promise.resolve();
    const data = mockStructuredData(outputSchema);
    return {
      data,
      rawText: JSON.stringify(data),
      usage: mockUsage,
    };
  },
});

// The default `{}` fails any strict valibot schema, so the playbook grade/derive
// paths have no working dev mock. Return a minimal schema-valid object for the
// two playbook structured-output features (keyed off the JSON-schema property
// set, since the adapter never sees the feature name), and keep `{}` for every
// other structured-output caller.
const mockStructuredData = (outputSchema: unknown): Record<string, unknown> => {
  const properties =
    typeof outputSchema === "object" &&
    outputSchema !== null &&
    "properties" in outputSchema &&
    typeof outputSchema.properties === "object" &&
    outputSchema.properties !== null
      ? (outputSchema.properties as Record<string, unknown>)
      : {};

  // playbook.verdict — tier-match. Return a plain "deviation" with no `matched`
  // so the object is valid regardless of whether the prompt listed fallbacks.
  if ("tier" in properties) {
    return { tier: "deviation", rationale: "Mock verdict." };
  }

  // playbook.derive-ask — question + content type.
  if ("question" in properties && "contentType" in properties) {
    return {
      question: "What does the contract say about this issue?",
      contentType: "text",
    };
  }

  return {};
};

if (isMockAI()) {
  registerBatchGenerator(generateBatchMock);
  registerTanStackMockTextAdapterFactory(createMockTextAdapter);
}
