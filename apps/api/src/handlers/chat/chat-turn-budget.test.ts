import { chat, EventType, StreamProcessor, toolDefinition } from "@tanstack/ai";
import type { AdapterYieldChunk, AnyTextAdapter } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";
import { CHAT_TURN_BUDGET } from "@stll/chat-limits";
import type { ChatTurnBudget } from "@stll/chat-limits";

import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  getAwaitingUserInteractions,
} from "@/api/handlers/chat/chat-message-parts";
import {
  CHAT_TURN_LOOP_STRATEGY,
  createChatTurnBudget,
} from "@/api/handlers/chat/chat-turn-budget";
import { findUnsettledStoredToolCalls } from "@/api/handlers/chat/chat-turn-settlement";
import {
  processServerChatStream,
  toChatMessage,
} from "@/api/handlers/chat/stream-chat";
import { createChatMessageIdMapper } from "@/api/handlers/chat/stream-message-identity";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type {
  ChatMessage,
  ChatPart,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { abortControllerFromSignal } from "@/api/lib/tanstack-ai-generate";

const SEARCH_TOOL_NAME = "web_search";
const ANSWER_MESSAGE_ID = toSafeId<"chatMessage">(
  "22222222-2222-4222-8222-222222222222",
);

/**
 * A model that asks for the search tool again after every result, as a model
 * stuck on a search does, and reports `promptTokens` for every call.
 */
const searchForeverAdapter = ({
  callIdPrefix = "call",
  promptTokens,
  textBeforeCall,
}: {
  callIdPrefix?: string;
  promptTokens: number;
  textBeforeCall?: number;
}): { adapter: AnyTextAdapter; modelCalls: () => number } => {
  let calls = 0;
  const adapter: AnyTextAdapter = {
    kind: "text",
    name: "search-forever",
    model: "search-forever",
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    async *chatStream({ model, runId, threadId }) {
      calls += 1;
      const callId = `${callIdPrefix}-${String(calls)}`;
      const timestamp = Date.now();
      yield {
        type: EventType.RUN_STARTED,
        runId: runId ?? "run-1",
        threadId: threadId ?? "thread-1",
        model,
        timestamp,
      } satisfies AdapterYieldChunk;
      if (calls === textBeforeCall) {
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId: `provider-message-${String(calls)}`,
          role: "assistant",
          model,
          timestamp,
        } satisfies AdapterYieldChunk;
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `provider-message-${String(calls)}`,
          delta: "Some lists are long",
          model,
          timestamp,
        } satisfies AdapterYieldChunk;
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId: `provider-message-${String(calls)}`,
          model,
          timestamp,
        } satisfies AdapterYieldChunk;
      }
      yield {
        // The executor the provider seam stamps on every server tool call.
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
        type: EventType.TOOL_CALL_START,
        toolCallId: callId,
        toolCallName: SEARCH_TOOL_NAME,
        parentMessageId: `provider-message-${String(calls)}`,
        timestamp,
      } satisfies AdapterYieldChunk;
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: callId,
        delta: JSON.stringify({ query: "court fees" }),
        model,
        timestamp,
      } satisfies AdapterYieldChunk;
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId: callId,
        input: { query: "court fees" },
        timestamp,
      } satisfies AdapterYieldChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId: runId ?? "run-1",
        threadId: threadId ?? "thread-1",
        finishReason: "tool_calls",
        model,
        timestamp,
        usage: {
          promptTokens,
          completionTokens: 1,
          totalTokens: promptTokens + 1,
        },
      } satisfies AdapterYieldChunk;
    },
    structuredOutput: () => {
      throw new Error("Structured output is not part of this fixture");
    },
  };
  return { adapter, modelCalls: () => calls };
};

/**
 * The search tool as an always-allowed grant leaves it: no approval gate, so
 * nothing but the budget stands between the model and its next call.
 */
const grantedSearchTool = () => {
  const executed: string[] = [];
  const tool = toolDefinition({
    name: SEARCH_TOOL_NAME,
    description: "Searches the web",
    inputSchema: toTanStackToolSchema(v.object({ query: v.string() })),
  }).server(async (_input, context) => {
    executed.push(context?.toolCallId ?? "unknown");
    return await Promise.resolve({ results: ["Court fees act"] });
  });
  return { executed, tool };
};

/** Runs one request of a turn through the persistence path `streamChat` uses. */
const runTurnRequest = async ({
  budget,
  initialMessages = [],
  promptTokens,
  callIdPrefix,
  textBeforeCall,
}: {
  budget: ChatTurnBudget;
  initialMessages?: ChatMessage[];
  promptTokens: number;
  callIdPrefix?: string;
  textBeforeCall?: number;
}) => {
  const { adapter, modelCalls } = searchForeverAdapter({
    promptTokens,
    ...(callIdPrefix === undefined ? {} : { callIdPrefix }),
    ...(textBeforeCall === undefined ? {} : { textBeforeCall }),
  });
  const { executed, tool } = grantedSearchTool();
  const owningMessage = initialMessages.findLast(
    (message) => message.role === "assistant",
  );
  const turnBudget = createChatTurnBudget({ budget, owningMessage });
  let responseMessage: ChatMessage | null = null;
  const processor = new StreamProcessor({
    events: {
      onStreamEnd: (message) => {
        responseMessage = toChatMessage(message);
      },
    },
  });
  const deadline = new AbortController();
  const finish: {
    event:
      | Parameters<Parameters<typeof processServerChatStream>[0]["onFinish"]>[0]
      | null;
  } = { event: null };
  const output = processServerChatStream({
    abortSignal: abortControllerFromSignal(deadline.signal).signal,
    deadlineSignal: deadline.signal,
    getResponseMessage: () => responseMessage,
    initialMessages,
    mapMessageId: createChatMessageIdMapper(() => ANSWER_MESSAGE_ID),
    onFinish: (event) => {
      finish.event = event;
    },
    processor,
    source: chat({
      adapter,
      agentLoopStrategy: CHAT_TURN_LOOP_STRATEGY,
      messages: [{ role: "user", content: "Find the court fees" }],
      middleware: [turnBudget.middleware],
      threadId: "thread-1",
      tools: [tool],
    }),
    turnBudget,
  });
  const chunks: PublicStreamChunk[] = [];
  for await (const chunk of output) {
    chunks.push(chunk);
  }
  if (finish.event === null) {
    return expect.unreachable("The turn must settle");
  }
  return { chunks, executed, finish: finish.event, modelCalls: modelCalls() };
};

const toolCallIdsOf = (parts: readonly ChatPart[]): string[] =>
  parts.flatMap((part) => (part.type === "tool-call" ? [part.id] : []));

/** What a later request reads back from the row the turn stored. */
const reload = (message: PersistableChatMessage): ChatMessage =>
  chatMessageFromPersisted({
    content: structuredClone(chatMessageContentFromMessage(message)),
    id: ANSWER_MESSAGE_ID,
    role: "assistant",
  });

describe("an assistant turn's budget", () => {
  test("the shared budget is what every chat turn runs under", () => {
    expect(CHAT_TURN_BUDGET.maxToolCalls).toBeGreaterThan(0);
    expect(CHAT_TURN_BUDGET.maxPromptTokens).toBeGreaterThan(0);
    expect(createChatTurnBudget({ owningMessage: undefined }).budget).toBe(
      CHAT_TURN_BUDGET,
    );
  });

  test("an always-allowed tool that keeps asking for itself stops exactly at the tool-call cap", async () => {
    const { executed, finish, modelCalls } = await runTurnRequest({
      budget: { maxToolCalls: 3, maxPromptTokens: 1_000_000 },
      promptTokens: 10,
    });

    // Without the budget the loop runs on to the engine's own ceiling; the
    // model here never stops asking.
    expect(executed).toEqual(["call-1", "call-2", "call-3"]);
    expect(modelCalls).toBe(3);
    expect(finish.outcome).toEqual({
      type: "paused",
      reason: "tool-calls",
      toolCalls: 3,
    });
    expect(toolCallIdsOf(finish.responseMessage.parts)).toEqual([
      "call-1",
      "call-2",
      "call-3",
    ]);
    expect(finish.responseMessage.metadata.turnOutcome).toEqual(finish.outcome);
    expect(finish.responseMessage.metadata.turnSpend).toEqual({
      promptTokens: 30,
    });
  });

  test("a capped turn keeps text and every completed tool call", async () => {
    const { chunks, finish } = await runTurnRequest({
      budget: { maxToolCalls: 2, maxPromptTokens: 1_000_000 },
      promptTokens: 10,
      textBeforeCall: 2,
    });

    expect(finish.outcome).toEqual({
      type: "paused",
      reason: "tool-calls",
      toolCalls: 2,
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: EventType.TEXT_MESSAGE_END,
        metadata: { turnOutcome: finish.outcome },
      }),
    );
    expect(
      finish.responseMessage.parts.map((part) => {
        if (part.type === "tool-call") {
          return [part.type, part.id, part.state, part.output];
        }
        if (part.type === "tool-result") {
          return [part.type, part.toolCallId, part.state];
        }
        return part.type === "text" ? [part.type, part.content] : [part.type];
      }),
    ).toEqual([
      ["tool-call", "call-1", "complete", { results: ["Court fees act"] }],
      ["tool-result", "call-1", "complete"],
      ["text", "Some lists are long"],
      ["tool-call", "call-2", "complete", { results: ["Court fees act"] }],
      ["tool-result", "call-2", "complete"],
    ]);
  });

  test("a turn whose model calls read too many prompt tokens stops at the token cap", async () => {
    const { executed, finish } = await runTurnRequest({
      budget: { maxToolCalls: 50, maxPromptTokens: 1000 },
      promptTokens: 400,
    });

    // 400 + 400 stays under 1000; the third call's 400 reaches it.
    expect(executed).toEqual(["call-1", "call-2", "call-3"]);
    expect(finish.outcome).toEqual({
      type: "paused",
      reason: "prompt-tokens",
      toolCalls: 3,
    });
    expect(finish.responseMessage.metadata.turnSpend).toEqual({
      promptTokens: 1200,
    });
  });

  test("a paused turn reloads paused, and nothing runs until the user sends a message", async () => {
    const { finish } = await runTurnRequest({
      budget: { maxToolCalls: 2, maxPromptTokens: 1_000_000 },
      promptTokens: 10,
    });
    const reloaded = reload(finish.responseMessage);

    expect(reloaded.metadata?.turnOutcome).toEqual({
      type: "paused",
      reason: "tool-calls",
      toolCalls: 2,
    });
    expect(reloaded.parts).toEqual(finish.responseMessage.parts);
    // No card or client tool is owed: a reopened page has nothing to answer
    // on its own, so the next step is the user's.
    expect(getAwaitingUserInteractions(reloaded)).toEqual([]);
    expect(
      findUnsettledStoredToolCalls({
        outcome: "paused",
        parts: reloaded.parts,
      }),
    ).toEqual([]);
  });

  test("a later request of the same turn counts what the stored turn already spent", async () => {
    const first = await runTurnRequest({
      budget: { maxToolCalls: 2, maxPromptTokens: 1_000_000 },
      promptTokens: 100,
    });
    const stored = reload(first.finish.responseMessage);
    // The stored turn as a continuation request reads it (an approval's
    // answer resumes the same assistant message): the cap is the turn's, not
    // the request's.
    const { executed, finish } = await runTurnRequest({
      budget: { maxToolCalls: 3, maxPromptTokens: 1_000_000 },
      callIdPrefix: "later",
      initialMessages: [stored],
      promptTokens: 100,
    });

    expect(executed).toEqual(["later-1"]);
    expect(finish.outcome).toEqual({
      type: "paused",
      reason: "tool-calls",
      toolCalls: 3,
    });
    expect(finish.responseMessage.metadata.turnSpend).toEqual({
      promptTokens: 300,
    });
  });
});
