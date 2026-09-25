import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk, Tool, UIMessage } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { expect, test } from "bun:test";

// `patches/@tanstack%2Fai@0.54.0.patch` makes `StreamProcessor` write
// `TOOL_CALL_END.input` into the tool-call part's `arguments` even when
// argument deltas were streamed. Unpatched, the part keeps the raw wire
// string next to the normalized `input`, so a strict-mode OpenAI call
// persists with the widened `null`s the persistence validator rejects.
// Both tests go red when a version bump drops the patch; delete them with it.

const TOOL_NAME = "spawn";
const WIDENED_ARGUMENTS = '{"task":"list matters","context":null}';
const NORMALIZED_INPUT = { task: "list matters" };

type ToolCallPart = Extract<UIMessage["parts"][number], { type: "tool-call" }>;

const isToolCallPart = (
  part: UIMessage["parts"][number],
): part is ToolCallPart => part.type === "tool-call";

const persistToolCallPart = (chunks: readonly StreamChunk[]): ToolCallPart => {
  const captured: { message: UIMessage | null } = { message: null };
  const processor = new StreamProcessor({
    events: {
      onStreamEnd: (message) => {
        captured.message = message;
      },
    },
  });
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  processor.finalizeStream();
  const part = captured.message?.parts.find(isToolCallPart);
  if (part === undefined) {
    throw new Error("The stream produced no tool-call part");
  }
  return part;
};

test("the persisted tool-call arguments carry TOOL_CALL_END.input, not the streamed wire string", () => {
  // The fixture must differ, or the assertion below is vacuous.
  expect(JSON.parse(WIDENED_ARGUMENTS)).not.toEqual(NORMALIZED_INPUT);
  const timestamp = Date.now();
  const model = "fixture";

  const part = persistToolCallPart([
    {
      type: EventType.RUN_STARTED,
      runId: "run-1",
      threadId: "thread-1",
      model,
      timestamp,
    },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "call-1",
      toolCallName: TOOL_NAME,
      parentMessageId: "provider-message-1",
      timestamp,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call-1",
      delta: WIDENED_ARGUMENTS,
      model,
      timestamp,
    },
    {
      type: EventType.TOOL_CALL_END,
      toolCallId: "call-1",
      input: NORMALIZED_INPUT,
      timestamp,
    },
    {
      type: EventType.RUN_FINISHED,
      runId: "run-1",
      threadId: "thread-1",
      finishReason: "tool_calls",
      model,
      timestamp,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    },
  ]);

  expect(part.state).toBe("input-complete");
  expect(part.input).toEqual(NORMALIZED_INPUT);
  expect(JSON.parse(part.arguments)).toEqual(NORMALIZED_INPUT);
});

// A call can be completed before its TOOL_CALL_END arrives (RUN_FINISHED
// completes every open call). The canonical input still replaces the
// arguments, and the part keeps the state it already reached.
test("TOOL_CALL_END.input replaces the arguments of a call that was already completed", () => {
  const timestamp = Date.now();
  const model = "fixture";

  const part = persistToolCallPart([
    {
      type: EventType.RUN_STARTED,
      runId: "run-1",
      threadId: "thread-1",
      model,
      timestamp,
    },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "call-1",
      toolCallName: TOOL_NAME,
      parentMessageId: "provider-message-1",
      timestamp,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call-1",
      delta: WIDENED_ARGUMENTS,
      model,
      timestamp,
    },
    {
      type: EventType.RUN_FINISHED,
      runId: "run-1",
      threadId: "thread-1",
      finishReason: "tool_calls",
      model,
      timestamp,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    },
    {
      type: EventType.TOOL_CALL_END,
      toolCallId: "call-1",
      input: NORMALIZED_INPUT,
      timestamp,
    },
  ]);

  expect(part.state).toBe("input-complete");
  expect(part.input).toEqual(NORMALIZED_INPUT);
  expect(JSON.parse(part.arguments)).toEqual(NORMALIZED_INPUT);
});

// An input JSON cannot carry is not canonical: `arguments` and `input` both
// stay with the streamed value rather than disagreeing.
test.each([
  ["throws on serialization", { task: "list matters", count: 1n }],
  ["serializes to undefined", () => "list matters"],
])(
  "keeps the streamed arguments and input when TOOL_CALL_END.input %s",
  (_case, input) => {
    const timestamp = Date.now();
    const model = "fixture";

    const part = persistToolCallPart([
      {
        type: EventType.RUN_STARTED,
        runId: "run-1",
        threadId: "thread-1",
        model,
        timestamp,
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: TOOL_NAME,
        parentMessageId: "provider-message-1",
        timestamp,
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-1",
        delta: WIDENED_ARGUMENTS,
        model,
        timestamp,
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-1", input, timestamp },
      {
        type: EventType.RUN_FINISHED,
        runId: "run-1",
        threadId: "thread-1",
        finishReason: "tool_calls",
        model,
        timestamp,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ]);

    expect(part.state).toBe("input-complete");
    expect(part.arguments).toBe(WIDENED_ARGUMENTS);
    expect(part.input).toEqual(JSON.parse(WIDENED_ARGUMENTS));
  },
);

const strictTool = {
  name: TOOL_NAME,
  description: "Run one delegated task.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string" },
      context: { type: "string" },
    },
    required: ["task"],
  },
} satisfies Tool;

// End to end on the installed stack: the OpenAI Responses adapter streams
// the widened wire string, undoes the widening on TOOL_CALL_END, and the
// processor persists that value as the arguments.
test("an OpenAI strict-mode null on an optional field never reaches the persisted arguments", async () => {
  const adapter = createOpenaiChat("gpt-5.2", "test-key");
  Reflect.set(adapter, "client", {
    responses: {
      create: () =>
        (async function* () {
          yield {
            type: "response.created",
            response: {
              id: "response-1",
              model: "gpt-5.2",
              status: "in_progress",
            },
          };
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "item-1", name: TOOL_NAME },
          };
          yield {
            type: "response.function_call_arguments.delta",
            item_id: "item-1",
            delta: WIDENED_ARGUMENTS,
          };
          yield {
            type: "response.function_call_arguments.done",
            item_id: "item-1",
            arguments: WIDENED_ARGUMENTS,
          };
          yield {
            type: "response.completed",
            response: {
              id: "response-1",
              model: "gpt-5.2",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: "item-1",
                  name: TOOL_NAME,
                  arguments: WIDENED_ARGUMENTS,
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          };
        })(),
    },
  });

  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.chatStream({
    logger: resolveDebugOption(false),
    messages: [{ role: "user", content: "List my matters." }],
    model: adapter.model,
    tools: [strictTool],
  })) {
    chunks.push(chunk);
  }
  const streamedArguments = chunks
    .flatMap((chunk) =>
      chunk.type === EventType.TOOL_CALL_ARGS ? [chunk.delta] : [],
    )
    .join("");
  expect(streamedArguments).toBe(WIDENED_ARGUMENTS);

  const part = persistToolCallPart(chunks);
  expect(part.input).toEqual(NORMALIZED_INPUT);
  expect(JSON.parse(part.arguments)).toEqual(NORMALIZED_INPUT);
});
