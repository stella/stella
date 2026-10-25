import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import type {
  ConnectConnectionAdapter,
  RunAgentInputContext,
  UIMessage,
} from "@tanstack/ai-client";
import { panic } from "better-result";
import { expect } from "bun:test";

import { projectCanonicalChatUIMessages } from "@/components/chat/chat-ui-tools";

import { toPersistedChatMessages } from "../chat-persisted-messages";

export const LOCAL_TOOL_NAME = "mcp__records__lookup";

export const encodeChunks = (chunks: readonly StreamChunk[]) =>
  new TextEncoder().encode(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
  );

export const startAnswer = (
  run: RunAgentInputContext,
  messageId: string,
): StreamChunk[] => [
  { type: EventType.RUN_STARTED, runId: run.runId, threadId: run.threadId },
  { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
];

export const finishAnswer = (
  run: RunAgentInputContext,
  messageId: string,
): StreamChunk[] => [
  { type: EventType.TEXT_MESSAGE_END, messageId },
  {
    type: EventType.RUN_FINISHED,
    runId: run.runId,
    threadId: run.threadId,
    metadata: { tanstack: { finishReason: "stop" } },
  },
];

type ToolCallOptions = { callId: string; messageId: string };

export const toolCall = ({
  callId,
  messageId,
}: ToolCallOptions): StreamChunk[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId: callId,
    toolCallName: LOCAL_TOOL_NAME,
    parentMessageId: messageId,
  },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: "{}" },
  { type: EventType.TOOL_CALL_END, toolCallId: callId },
];

export const pendingClientTool = (
  run: RunAgentInputContext,
  callId: string,
): StreamChunk => ({
  type: EventType.RUN_FINISHED,
  runId: run.runId,
  threadId: run.threadId,
  metadata: { tanstack: { finishReason: "stop" } },
  outcome: { type: "success", pendingToolCallIds: [callId] },
});

export const sseResponse = (chunks: readonly StreamChunk[]) =>
  new Response(encodeChunks(chunks), {
    headers: { "Content-Type": "text/event-stream" },
  });

/** Each real SSE adapter captures the SDK context of its own request. */
export const createSseFixture = (
  respond: (run: RunAgentInputContext, index: number) => Response,
) => {
  const requests: RunAgentInputContext[] = [];
  const connection = {
    connect: (messages, data, signal, run) => {
      if (run === undefined) {
        return panic("The SDK omitted its run context");
      }
      requests.push(run);
      const index = requests.length;
      return fetchServerSentEvents("https://chat.test", {
        fetchClient: () => Promise.resolve(respond(run, index)),
      }).connect(messages, data, signal, run);
    },
  } satisfies ConnectConnectionAdapter;
  return { connection, requests };
};

/** The SDK yields after 8ms of processing; no wall-clock delay is needed. */
export const pauseSdkSubscriber = () => {
  const paused = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const previousNow = Object.getOwnPropertyDescriptor(performance, "now");
  const previousScheduler = Object.getOwnPropertyDescriptor(
    globalThis,
    "scheduler",
  );
  let state: "armed" | "paused" | "released" = "armed";
  let clock = 0;
  const restore = () => {
    released.resolve(undefined);
    if (previousNow === undefined) {
      Reflect.deleteProperty(performance, "now");
    } else {
      Object.defineProperty(performance, "now", previousNow);
    }
    if (previousScheduler === undefined) {
      Reflect.deleteProperty(globalThis, "scheduler");
    } else {
      Object.defineProperty(globalThis, "scheduler", previousScheduler);
    }
  };
  try {
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => clock,
    });
    Object.defineProperty(globalThis, "scheduler", {
      configurable: true,
      value: {
        yield: async () => {
          if (state !== "armed") {
            return;
          }
          state = "paused";
          paused.resolve(undefined);
          await released.promise;
        },
      },
    });
  } catch (error) {
    restore();
    throw error;
  }
  return {
    paused: paused.promise,
    consumeBudget: () => {
      clock += 9;
    },
    release: () => {
      state = "released";
      released.resolve(undefined);
    },
    restore,
  };
};

/** Exercise the page's projection, its stored value, and a fresh SDK load. */
export const expectPersistedReloadParity = (messages: UIMessage[]) => {
  const shown = projectCanonicalChatUIMessages(
    toPersistedChatMessages(messages),
  );
  const stored = structuredClone(toPersistedChatMessages(messages));
  const reloaded = new ChatClient({
    initialMessages: stored,
    connection: { connect: () => panic("A persisted reload must not send") },
  });
  try {
    expect(
      projectCanonicalChatUIMessages(
        toPersistedChatMessages(reloaded.getMessages()),
      ),
    ).toEqual(shown);
    return shown;
  } finally {
    reloaded.dispose();
  }
};
