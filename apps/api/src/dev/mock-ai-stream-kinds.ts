import { EventType } from "@tanstack/ai";
import type { AdapterYieldChunk, ModelMessage, TokenUsage } from "@tanstack/ai";

import { MOCK_AI_STREAM_KIND_MARKERS } from "@/api/dev/mock-ai-stream-kind-markers";
import type { MockAiStreamKind } from "@/api/dev/mock-ai-stream-kind-markers";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/subagent-tool-shared";

// The mock model's streams of one kind of chunk each: a user message holding
// a kind's marker (`MOCK_AI_STREAM_KIND_MARKERS`) makes the mock stream that
// kind as a few hundred tiny deltas a few milliseconds apart, the densest
// update rate a real provider sends. The e2e spec
// `apps/web/e2e/specs/chat-stream-commit-budget.spec.ts` sends each marker
// and holds the thread page's commit rate to the kind's budget.

/** How many deltas a kind streams, and how far apart. */
const DELTAS = 300;
const DELTA_INTERVAL_MS = 5;
/** How many tool calls the tool-output stream fans out to. */
const TOOL_OUTPUT_CALLS = 60;

const REPLY = "Done: the stream is complete.";

type StreamContext = {
  messageId: string;
  messages: readonly ModelMessage[];
  model: string;
  runId: string;
  threadId: string;
  timestamp: number;
  usage: TokenUsage;
};

const KINDS = Object.keys(MOCK_AI_STREAM_KIND_MARKERS).filter(
  (kind): kind is MockAiStreamKind => kind in MOCK_AI_STREAM_KIND_MARKERS,
);

/** The kind whose marker `text` holds, if any. */
export const mockAiStreamKindOf = (
  text: string,
): MockAiStreamKind | undefined =>
  KINDS.find((kind) => text.includes(MOCK_AI_STREAM_KIND_MARKERS[kind]));

const words = (count: number) =>
  Array.from({ length: count }, (_, index) => `w${String(index)} `);

/** `serialized` cut into `count` pieces of about equal length. */
const piecesOf = (serialized: string, count: number): string[] => {
  const pieceCount = Math.min(count, serialized.length);
  return Array.from({ length: pieceCount }, (_, index) =>
    serialized.slice(
      Math.floor((index * serialized.length) / pieceCount),
      Math.floor(((index + 1) * serialized.length) / pieceCount),
    ),
  );
};

async function* paced<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
    await Bun.sleep(DELTA_INTERVAL_MS);
  }
}

function* answer(
  { messageId, model, timestamp }: StreamContext,
  text: string,
): Generator<AdapterYieldChunk> {
  yield {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: "assistant",
    model,
    timestamp,
  };
  yield {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: text,
    model,
    timestamp,
  };
  yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp };
}

const finished = (
  { model, runId, threadId, timestamp, usage }: StreamContext,
  finishReason: "stop" | "tool_calls",
): AdapterYieldChunk => ({
  type: EventType.RUN_FINISHED,
  runId,
  threadId,
  model,
  timestamp,
  finishReason,
  usage,
});

/** A continuation after the kind's tool calls answered: the reply. */
const answersToolResults = ({ messages }: StreamContext): boolean =>
  messages.at(-1)?.role === "tool";

async function* toolCallStreaming(
  context: StreamContext,
  {
    input,
    name,
    toolCallId,
  }: { input: unknown; name: string; toolCallId: string },
  pieces: number,
): AsyncGenerator<AdapterYieldChunk> {
  const { messageId, model, timestamp } = context;
  yield {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: name,
    parentMessageId: messageId,
    timestamp,
  };
  const deltas = piecesOf(JSON.stringify(input), pieces);
  for await (const delta of paced(deltas)) {
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta,
      model,
      timestamp,
    };
  }
  yield { type: EventType.TOOL_CALL_END, toolCallId, timestamp };
}

/**
 * Each kind's stream, after the run's `RUN_STARTED`. Keyed by every kind,
 * so a kind the web app budgets for has a stream here.
 */
const STREAMS = {
  async *reasoning(context) {
    const { model, timestamp } = context;
    const reasoningId = `mock-reasoning-${context.runId}`;
    yield {
      type: EventType.REASONING_START,
      messageId: reasoningId,
      model,
      timestamp,
    };
    yield {
      type: EventType.REASONING_MESSAGE_START,
      messageId: reasoningId,
      role: "reasoning",
      model,
      timestamp,
    };
    for await (const delta of paced(words(DELTAS))) {
      yield {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: reasoningId,
        delta,
        model,
        timestamp,
      };
    }
    yield {
      type: EventType.REASONING_MESSAGE_END,
      messageId: reasoningId,
      model,
      timestamp,
    };
    yield {
      type: EventType.REASONING_END,
      messageId: reasoningId,
      model,
      timestamp,
    };
    yield* answer(context, REPLY);
    yield finished(context, "stop");
  },
  async *status(context) {
    const { model, timestamp } = context;
    for await (const index of paced(
      Array.from({ length: DELTAS / 2 }, (_, step) => step),
    )) {
      const stepName = `mock-status-${String(index)}`;
      yield {
        type: EventType.STEP_STARTED,
        stepName,
        stepId: stepName,
        model,
        timestamp,
      };
      yield {
        type: EventType.STEP_FINISHED,
        stepName,
        stepId: stepName,
        model,
        timestamp,
      };
    }
    yield* answer(context, REPLY);
    yield finished(context, "stop");
  },
  async *subagent(context) {
    if (answersToolResults(context)) {
      yield* answer(context, REPLY);
      yield finished(context, "stop");
      return;
    }
    // The subagent's own run streams the text kind: its task holds that
    // kind's marker.
    yield* toolCallStreaming(
      context,
      {
        input: {
          subagents: [
            {
              title: "Stream a reply",
              task: `${MOCK_AI_STREAM_KIND_MARKERS.text}, for the subagent`,
            },
          ],
        },
        name: SPAWN_SUBAGENTS_TOOL_NAME,
        toolCallId: `mock-subagent-call-${context.runId}`,
      },
      1,
    );
    yield finished(context, "tool_calls");
  },
  async *text(context) {
    const { messageId, model, timestamp } = context;
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      model,
      timestamp,
    };
    for await (const delta of paced(words(DELTAS))) {
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta,
        model,
        timestamp,
      };
    }
    yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp };
    yield finished(context, "stop");
  },
  async *"tool-input"(context) {
    // The ask-user card: a client tool, so the run then waits on the user.
    yield* toolCallStreaming(
      context,
      {
        input: {
          analysis: words(DELTAS).join(""),
          questions: [
            { question: "Which side?", reason: "It decides the draft." },
          ],
        },
        name: ASK_USER_TOOL_NAME,
        toolCallId: `mock-ask-user-call-${context.runId}`,
      },
      DELTAS,
    );
    yield finished(context, "tool_calls");
  },
  async *"tool-output"(context) {
    if (answersToolResults(context)) {
      yield* answer(context, REPLY);
      yield finished(context, "stop");
      return;
    }
    // Many cheap reads with distinct inputs (identical ones would read as a
    // loop), whose results stream back as each finishes.
    for (let index = 0; index < TOOL_OUTPUT_CALLS; index += 1) {
      yield* toolCallStreaming(
        context,
        {
          input: { templateId: `mock-template-${String(index)}` },
          name: "describe_template",
          toolCallId: `mock-describe-call-${context.runId}-${String(index)}`,
        },
        1,
      );
    }
    yield finished(context, "tool_calls");
  },
} as const satisfies Record<
  MockAiStreamKind,
  (context: StreamContext) => AsyncGenerator<AdapterYieldChunk>
>;

/**
 * The run `kind`'s marker asks for.
 *
 * @yields Each provider event of the run, after its `RUN_STARTED`.
 */
export async function* mockAiStreamKindChunks(
  kind: MockAiStreamKind,
  context: StreamContext,
): AsyncGenerator<AdapterYieldChunk> {
  yield* STREAMS[kind](context);
}
