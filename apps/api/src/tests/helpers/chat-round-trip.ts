import {
  EventType,
  maxIterations,
  StreamProcessor,
  toServerSentEventsResponse,
} from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk, TokenUsage } from "@tanstack/ai";
import { panic } from "better-result";

import {
  processServerChatStream,
  pruneOrphanedToolParts,
  toChatMessage,
} from "@/api/handlers/chat/stream-chat";
import type { streamChat } from "@/api/handlers/chat/stream-chat";
import { createTurnMessageIdMapper } from "@/api/handlers/chat/stream-message-identity";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { chatToolMapToArray } from "@/api/lib/chat/chat-tool-types";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { withSseHeartbeat } from "@/api/lib/sse";
import { abortControllerFromSignal } from "@/api/lib/tanstack-ai-generate";

// A shared chat round-trip harness: a scripted provider adapter driven through
// the real `@tanstack/ai` `chat()` loop, and a `streamResponse` that runs that
// loop through the production stream processor and hands the result to the
// caller's `onFinish` persistence. Model resolution is the one substituted
// piece; everything the SDK decides (tool execution, approval interrupts,
// per-iteration RUN_FINISHED) is the SDK's own.

type ScriptedTurnUsage = Pick<
  TokenUsage,
  "completionTokens" | "promptTokens" | "totalTokens"
>;

/** One provider iteration of a scripted run. */
export type ScriptedTurn =
  | {
      arguments: string;
      toolName: string;
      type: "tool-call";
      usage?: ScriptedTurnUsage | undefined;
    }
  | {
      finishReason: "content_filter" | "length" | "stop";
      text: string;
      type: "text";
      usage?: ScriptedTurnUsage | undefined;
    }
  | {
      code?: string | undefined;
      message: string;
      type: "error";
    };

const DEFAULT_TURN_USAGE = {
  completionTokens: 1,
  promptTokens: 1,
  totalTokens: 2,
} as const satisfies ScriptedTurnUsage;

/**
 * A text adapter answering the n-th provider iteration with the n-th scripted
 * turn. Throws when the loop asks for more iterations than were scripted, so a
 * run that re-calls the model unexpectedly fails loudly.
 */
export const createScriptedTextAdapter = (
  turns: readonly ScriptedTurn[],
): AnyTextAdapter => {
  let turnIndex = 0;
  return {
    kind: "text",
    name: "scripted",
    model: "scripted",
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    async *chatStream({ model, runId, threadId }) {
      const index = turnIndex;
      turnIndex += 1;
      // A provider answers asynchronously; so does the script.
      const turn = await Promise.resolve(turns.at(index));
      if (turn === undefined) {
        panic("The scripted adapter ran out of turns");
      }
      const resolvedRunId = runId ?? "run-1";
      const resolvedThreadId = threadId ?? "thread-1";
      const messageId = `provider-message-${String(index + 1)}`;
      const timestamp = Date.now();
      yield {
        type: EventType.RUN_STARTED,
        runId: resolvedRunId,
        threadId: resolvedThreadId,
        model,
        timestamp,
      } satisfies StreamChunk;
      switch (turn.type) {
        case "tool-call": {
          const callId = `call-${String(index + 1)}`;
          yield {
            type: EventType.TOOL_CALL_START,
            toolCallId: callId,
            toolCallName: turn.toolName,
            parentMessageId: messageId,
            timestamp,
          } satisfies StreamChunk;
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: callId,
            delta: turn.arguments,
            model,
            timestamp,
          } satisfies StreamChunk;
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: callId,
            timestamp,
          } satisfies StreamChunk;
          yield {
            type: EventType.RUN_FINISHED,
            runId: resolvedRunId,
            threadId: resolvedThreadId,
            finishReason: "tool_calls",
            model,
            timestamp,
            usage: turn.usage ?? DEFAULT_TURN_USAGE,
          } satisfies StreamChunk;
          return;
        }
        case "text": {
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
            delta: turn.text,
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
            finishReason: turn.finishReason,
            model,
            timestamp,
            usage: turn.usage ?? DEFAULT_TURN_USAGE,
          } satisfies StreamChunk;
          return;
        }
        case "error": {
          yield {
            type: EventType.RUN_ERROR,
            message: turn.message,
            ...(turn.code === undefined ? {} : { code: turn.code }),
            model,
            timestamp,
          } satisfies StreamChunk;
          return;
        }
        default: {
          turn satisfies never;
          panic("Unhandled scripted turn");
        }
      }
    },
    structuredOutput: () =>
      panic("Structured output is not part of the scripted adapter"),
  };
};

type StreamResponse = typeof streamChat;

/**
 * A `streamResponse` dependency for `createSendMessage` that runs the real
 * `chat()` loop over the request's own messages and tool set, then persists
 * through the handler's `onFinish` exactly as `streamChat` does. Each call
 * takes the next adapter, so one test can script several requests.
 */
export const createScriptedStreamResponse = (
  nextAdapter: () => AnyTextAdapter,
): StreamResponse => {
  const streamResponse: StreamResponse = async ({
    abortSignal,
    messages: rawMessages,
    onFinish,
    owningAssistantMessageId,
    parentRunId,
    resume,
    runId,
    threadId,
    tools,
  }) => {
    const messages = pruneOrphanedToolParts(rawMessages);
    const abortController = abortControllerFromSignal(abortSignal);
    const captured: { message: ChatMessage | null } = { message: null };
    const processor = new StreamProcessor({
      initialMessages: messages,
      events: {
        onStreamEnd: (message) => {
          captured.message = toChatMessage(message);
        },
      },
    });
    const source = streamChatChunks({
      abortController,
      adapter: nextAdapter(),
      agentLoopStrategy: maxIterations(5),
      messages,
      runId,
      threadId,
      tools: chatToolMapToArray(tools),
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(resume === undefined ? {} : { resume }),
    });
    const processed = processServerChatStream({
      abortSignal: abortController.signal,
      deadlineSignal: abortSignal,
      existingMessageIds: new Set(messages.map(({ id }) => id)),
      getResponseMessage: () => captured.message,
      mapMessageId: createTurnMessageIdMapper(owningAssistantMessageId),
      onFinish,
      processor,
      source,
    });
    return await Promise.resolve(
      withSseHeartbeat(
        toServerSentEventsResponse(processed, { abortController }),
      ),
    );
  };
  return streamResponse;
};

/** Read a streamed response to its end, so its terminal persistence runs. */
export const drainResponse = async (response: Response): Promise<string> =>
  await response.text();
