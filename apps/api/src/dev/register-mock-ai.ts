import { EventType } from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ContentPart,
  ModelMessage,
  StreamChunk,
  TextPart,
  TokenUsage,
} from "@tanstack/ai";

import { isMockAI } from "@/api/consts";
import { registerTanStackMockTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { generateBatchMock } from "@/api/lib/workflow/generate-batch-mock";
import { registerBatchGenerator } from "@/api/lib/workflow/generate-batch-provider";

// Dev/test-only preload: wired via the api `dev` script's `--preload`, never
// imported from `src/server.ts`. Registering the faker-backed mock generator here
// (rather than referencing it from the production handlers) keeps
// `generate-batch-mock` and `@faker-js/faker` out of the production build — both
// the compiled binary and the knip `--production` graph.

const MOCK_REPLY =
  "Mock assistant reply: streaming is stubbed because USE_MOCK_AI is set.";

// A user message containing this marker makes the mock adapter stream its
// reply as many small delayed chunks instead of one instant chunk, giving an
// e2e spec a real streaming window to hold open (e.g. to type into the
// composer while a response is still arriving).
const E2E_SLOW_STREAM_MARKER = "Stream slowly please";

const SLOW_STREAM_REPLY =
  "This mock reply streams back in many small pieces instead of arriving all " +
  "at once, so an end to end test has a real window while the assistant is " +
  "still responding. Each small piece lands only after a short delay, giving " +
  "the interface time to re-render before the whole message finally finishes " +
  "and the run completes for the test to inspect.";

// Word-ish deltas (each chunk keeps its trailing whitespace so the deltas
// concatenate back into SLOW_STREAM_REPLY exactly).
const SLOW_STREAM_CHUNKS = SLOW_STREAM_REPLY.match(/\S+\s*/gu) ?? [
  SLOW_STREAM_REPLY,
];

const SLOW_STREAM_CHUNK_DELAY_MS = 100;

const mockUsage: TokenUsage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};

const isTextPart = (part: ContentPart): part is TextPart =>
  part.type === "text";

// Adapter-facing messages carry either a plain string or a content-part array
// (see ModelMessage in @tanstack/ai); flatten either shape down to the text
// the marker check cares about.
const getLatestUserText = (messages: ModelMessage[]): string => {
  const latestUserMessage = messages.findLast(
    (message) => message.role === "user",
  );

  if (!latestUserMessage) {
    return "";
  }

  const { content } = latestUserMessage;
  if (typeof content === "string") {
    return content;
  }

  if (content === null) {
    return "";
  }

  return content
    .filter(isTextPart)
    .map((part) => part.content)
    .join("");
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
  async *chatStream({ model, runId, threadId, messages }) {
    const resolvedRunId = runId ?? "mock-run";
    const resolvedThreadId = threadId ?? "mock-thread";
    const messageId = "mock-message";
    const timestamp = Date.now();
    const slowStream = getLatestUserText(messages).includes(
      E2E_SLOW_STREAM_MARKER,
    );

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

    if (slowStream) {
      for (const delta of SLOW_STREAM_CHUNKS) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
          model,
          timestamp,
        } satisfies StreamChunk;
        // oxlint-disable-next-line no-await-in-loop -- sequential stream simulation: each chunk must land before the next delay starts, so an e2e spec sees a real streaming window
        await Bun.sleep(SLOW_STREAM_CHUNK_DELAY_MS);
      }
    } else {
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: MOCK_REPLY,
        model,
        timestamp,
      } satisfies StreamChunk;
    }

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
      ? outputSchema.properties
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
