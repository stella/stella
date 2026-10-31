import {
  chat,
  convertMessagesToModelMessages,
  maxIterations,
  toolDefinition,
} from "@tanstack/ai";
import type { AnyTextAdapter, ModelMessage } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { isChatPart } from "@/api/handlers/chat/chat-message-parts";
import { settleHistoryForRun } from "@/api/handlers/chat/chat-turn-settlement";
import {
  guardProviderHistory,
  withoutRepeatedCalls,
} from "@/api/handlers/chat/provider-history";
import { answerCallsInTheirStep } from "@/api/handlers/chat/step-answers";
import {
  processServerChatStream,
  toChatMessage,
} from "@/api/handlers/chat/stream-chat";
import type { GuardedChatSurfaces } from "@/api/handlers/chat/stream-chat";
import { createTurnMessageIdMapper } from "@/api/handlers/chat/stream-message-identity";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { withProviderStreamContract } from "@/api/lib/chat/provider-stream-contract";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { toolCallStepOf } from "@/api/lib/chat/tool-call-step";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import {
  scriptedAdapterBase,
  scriptedTurnChunks,
} from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";
import { findTranscriptProblems } from "@/api/tests/helpers/provider-request-transcript";

type ToolCallPart = Extract<ChatPart, { type: "tool-call" }>;

const TOOL_NAME = "mcp__external__delete";

const deleteTool = toolDefinition({
  name: TOOL_NAME,
  description: "Deletes a document once the user approves",
  inputSchema: toTanStackToolSchema(v.object({ name: v.string() })),
  needsApproval: true,
}).server(async ({ name }) => ({ deleted: name }));

const argumentsOf = (id: string) => JSON.stringify({ name: id });

const approvalCall = (
  id: string,
  approval: boolean | undefined,
  fields: Partial<Pick<ToolCallPart, "output" | "state">> = {},
): ToolCallPart => ({
  approval: {
    id: `approval_${id}`,
    needsApproval: true,
    ...(approval === undefined ? {} : { approved: approval }),
  },
  arguments: argumentsOf(id),
  id,
  input: { name: id },
  name: TOOL_NAME,
  state: approval === undefined ? "approval-requested" : "approval-responded",
  type: "tool-call",
  ...fields,
});

const executed = (id: string): ChatPart[] => [
  approvalCall(id, true, { output: { deleted: id }, state: "complete" }),
];

const resultOf = (id: string): ChatPart => ({
  content: JSON.stringify({ deleted: id }),
  state: "complete",
  toolCallId: id,
  type: "tool-result",
});

const text = (content: string): ChatPart => ({ content, type: "text" });

const user = (id: string, content: string): ChatMessage => ({
  id,
  parts: [text(content)],
  role: "user",
});

const assistant = (parts: ChatPart[]): ChatMessage => ({
  id: "assistant-1",
  parts,
  role: "assistant",
});

/** A request as the provider reads it: no ids or timestamps. */
const promptOf = (messages: readonly ModelMessage[]): string[] =>
  messages.map((message) =>
    JSON.stringify({
      content: message.content,
      role: message.role,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls?.map((call) => ({
        arguments: call.function.arguments,
        id: call.id,
        name: call.function.name,
      })),
    }),
  );

/**
 * Runs one request of the thread through the SDK engine, from `history` as a
 * run hands it over, and returns the prompt of every model call it makes.
 */
const runRequest = async ({
  history,
  resumedMessageId,
  turns,
}: {
  history: ChatMessage[];
  resumedMessageId?: string;
  turns: ScriptedTurn[];
}): Promise<string[][]> => {
  const prompts: string[][] = [];
  const adapter: AnyTextAdapter = {
    ...scriptedAdapterBase,
    async *chatStream({ messages, model, runId, threadId }) {
      prompts.push(promptOf(messages));
      const turn =
        turns.at(prompts.length - 1) ??
        panic("The request asked the model more often than scripted");
      yield* scriptedTurnChunks(turn, {
        index: prompts.length - 1,
        model,
        runId: runId ?? "run-1",
        threadId: threadId ?? "thread-1",
      });
    },
    structuredOutput: () => panic("No structured output in this test"),
  };
  // The history exactly as a chat attempt dispatches it: settled, then the
  // provider's guarded copy, the only type the dispatch accepts.
  const messages: GuardedChatSurfaces["messages"] = guardProviderHistory({
    messages: settleHistoryForRun({ messages: history, resumedMessageId }),
    workspaceIds: [],
  });
  for await (const _chunk of chat({
    adapter,
    agentLoopStrategy: maxIterations(4),
    messages,
    tools: [deleteTool],
  })) {
    // Draining the stream runs the request.
  }
  expect(prompts).toHaveLength(turns.length);
  return prompts;
};

/** `chat.provider.prefix-stable` over the model calls of one thread, in
 *  order. */
const prefixBreaks = (prompts: readonly string[][]): OracleViolation[] =>
  violationsOf(
    CHAT_ORACLE.providerPrefixStable,
    prompts.slice(1).flatMap((prompt, index) => {
      const previous = prompts[index] ?? [];
      const offset = previous.findIndex(
        (message, at) => prompt[at] !== message,
      );
      return offset === -1
        ? []
        : [{ call: index + 1, offset, previous, next: prompt }];
    }),
  );

const stepWithCall = (content: string, id: string): ScriptedTurn => ({
  text: content,
  toolCalls: [
    { arguments: argumentsOf(id), toolCallId: id, toolName: TOOL_NAME },
  ],
  type: "step",
});

const answer = (content: string): ScriptedTurn => ({
  finishReason: "stop",
  text: content,
  type: "text",
});

describe("a call the user answered, in every later provider request", () => {
  test("stays answered right after its step when the model asks for a call after a denial", async () => {
    const question = user("user-1", "Delete the NDA");
    // The denial resumes the message: the model says more and asks again.
    const afterDenial = await runRequest({
      history: [question, assistant([approvalCall("call-1", false)])],
      resumedMessageId: "assistant-1",
      turns: [stepWithCall("Deleting the other one.", "call-2")],
    });
    const deniedThenAsked = [
      approvalCall("call-1", false),
      text("Deleting the other one."),
    ];
    // The fixture must reach the fault: the denied call's step is not the
    // last one of the message it resumes.
    expect(deniedThenAsked.at(-1)?.type).toBe("text");
    // The approval resumes the same message again.
    const afterApproval = await runRequest({
      history: [
        question,
        assistant([...deniedThenAsked, approvalCall("call-2", true)]),
      ],
      resumedMessageId: "assistant-1",
      turns: [answer("Deleted.")],
    });
    // A new message, with the whole turn stored.
    const nextTurn = await runRequest({
      history: [
        question,
        assistant([
          ...deniedThenAsked,
          ...executed("call-2"),
          resultOf("call-2"),
          text("Deleted."),
        ]),
        user("user-2", "Thanks"),
      ],
      turns: [answer("You're welcome.")],
    });

    expect(
      prefixBreaks([...afterDenial, ...afterApproval, ...nextTurn]),
    ).toEqual([]);
  });

  test("keeps a denial ahead of the approved call it was answered with", async () => {
    const question = user("user-1", "Delete both");
    const answered = await runRequest({
      history: [
        question,
        assistant([
          approvalCall("call-1", false),
          approvalCall("call-2", true),
        ]),
      ],
      resumedMessageId: "assistant-1",
      turns: [answer("Deleted one.")],
    });
    const nextTurn = await runRequest({
      history: [
        question,
        assistant([
          approvalCall("call-1", false),
          ...executed("call-2"),
          resultOf("call-2"),
          text("Deleted one."),
        ]),
        user("user-2", "Thanks"),
      ],
      turns: [answer("You're welcome.")],
    });

    expect(prefixBreaks([...answered, ...nextTurn])).toEqual([]);
  });

  test("moves nothing twice and keeps every other part in place", () => {
    const parts = [
      approvalCall("call-1", false),
      text("Deleting the other one."),
      ...executed("call-2"),
      resultOf("call-2"),
      text("Deleted."),
    ];
    const once = answerCallsInTheirStep(parts);

    expect(once.filter((part) => part.type !== "tool-result")).toEqual(
      parts.filter((part) => part.type !== "tool-result"),
    );
    expect(once.map((part) => part.type)).toEqual([
      "tool-call",
      "tool-result",
      "text",
      "tool-call",
      "tool-result",
      "text",
    ]);
    expect(answerCallsInTheirStep(once)).toBe(once);
  });

  test("leaves a message whose last step holds the answered call alone", () => {
    const parts = [
      text("Deleting both."),
      approvalCall("call-1", false),
      approvalCall("call-2", true),
    ];

    expect(answerCallsInTheirStep(parts)).toBe(parts);
  });
});

// Some stored threads repeat a call in later messages of the thread (an
// earlier release copied a denied call into each later answer of its turn).
describe("a call a stored thread repeats", () => {
  const history: ChatMessage[] = [
    user("user-1", "Delete the memo."),
    assistant([text("Kept."), approvalCall("call-memo", false)]),
    user("user-2", "Delete the lease."),
    {
      ...assistant([
        text("Kept."),
        approvalCall("call-memo", false),
        approvalCall("call-lease", true),
      ]),
      id: "assistant-2",
    },
  ];
  const requestOf = (messages: readonly ChatMessage[]) => ({
    earlierSteps: [],
    format: "model-messages" as const,
    messages: convertMessagesToModelMessages([...messages]),
  });

  test("is sent once, in the first message holding it", () => {
    // The fixture must reach the fault: as stored, the id repeats.
    expect(
      findTranscriptProblems(requestOf(history)).map(({ problem }) => problem),
    ).toContain("a tool call id repeats");

    const sent = guardProviderHistory({ messages: history, workspaceIds: [] });

    expect(findTranscriptProblems(requestOf(sent))).toEqual([]);
    expect(sent[1]?.parts).toEqual(history[1]?.parts);
    expect(sent[3]?.parts).toEqual([
      text("Kept."),
      approvalCall("call-lease", true),
    ]);
  });

  test("leaves a thread whose calls occur once alone", () => {
    const once = history.slice(0, 2);
    expect(withoutRepeatedCalls(once)).toBe(once);
  });
});

const STORED_ASSISTANT_ID = toSafeId<"chatMessage">(
  "11111111-1111-4111-8111-111111111111",
);

/**
 * Runs one request of the thread as a chat attempt does: through the stream
 * contract every provider adapter is held to, and folded into the message the
 * turn stores by the persistence path `streamChat` runs. Returns the prompt
 * of every model call and the stored message, so the next request starts
 * from what this one stored, not from parts a test wrote by hand.
 */
const runAndStore = async ({
  history,
  resumedMessageId,
  turns,
}: {
  history: ChatMessage[];
  resumedMessageId?: string;
  turns: ScriptedTurn[];
}): Promise<{ prompts: string[][]; stored: ChatMessage }> => {
  const prompts: string[][] = [];
  const adapter = withProviderStreamContract({
    ...scriptedAdapterBase,
    async *chatStream({ messages, model, runId, threadId }) {
      prompts.push(promptOf(messages));
      const turn =
        turns.at(prompts.length - 1) ??
        panic("The request asked the model more often than scripted");
      yield* scriptedTurnChunks(turn, {
        index: prompts.length - 1,
        model,
        runId: runId ?? "run-1",
        threadId: threadId ?? "thread-1",
      });
    },
    structuredOutput: () => panic("No structured output in this test"),
  });
  const initialMessages = settleHistoryForRun({
    messages: history,
    resumedMessageId,
  });
  const { processor, message } = createStreamMessageCapture({
    initialMessages,
    capture: toChatMessage,
  });
  const deadline = new AbortController();
  const finished: { message: ChatMessage | null } = { message: null };
  for await (const _chunk of processServerChatStream({
    abortSignal: deadline.signal,
    deadlineSignal: deadline.signal,
    getResponseMessage: message,
    initialMessages,
    mapMessageId: createTurnMessageIdMapper(STORED_ASSISTANT_ID),
    onFinish: ({ responseMessage }) => {
      finished.message = responseMessage;
    },
    processor,
    source: streamChatChunks({
      adapter,
      agentLoopStrategy: maxIterations(4),
      messages: guardProviderHistory({
        messages: initialMessages,
        workspaceIds: [],
      }),
      tools: [deleteTool],
    }),
  })) {
    // Draining the stream runs the request and stores its message.
  }
  expect(prompts).toHaveLength(turns.length);
  return {
    prompts,
    stored: finished.message ?? panic("The request stored no message"),
  };
};

/** `message` with the user's answer to the approval of call `id`. */
const withApprovalAnswer = (
  message: ChatMessage,
  id: string,
  approved: boolean,
): ChatMessage => ({
  ...message,
  parts: message.parts.map((part) => {
    if (part.type !== "tool-call" || part.id !== id || !("approval" in part)) {
      return part;
    }
    const answered: unknown = {
      ...part,
      approval: { ...part.approval, approved },
      state: "approval-responded",
    };
    return isChatPart(answered)
      ? answered
      : panic("The answered approval is not a chat part");
  }),
});

const promptEntrySchema = v.object({
  role: v.string(),
  toolCallId: v.optional(v.string()),
  toolCalls: v.optional(v.array(v.object({ id: v.string() }))),
});

/**
 * The calls a request sends without their answers right after them: the
 * messages that follow an assistant message's calls, up to the next message
 * that is not a tool result, answer exactly those calls.
 */
const unansweredCalls = (prompt: readonly string[]): string[] => {
  const entries = prompt.map((entry) =>
    v.parse(promptEntrySchema, JSON.parse(entry)),
  );
  return entries.flatMap((entry, index) => {
    const calls = (entry.toolCalls ?? []).map(({ id }) => id).toSorted();
    const answers: string[] = [];
    for (const next of entries.slice(index + 1)) {
      if (next.role !== "tool") {
        break;
      }
      answers.push(next.toolCallId ?? "");
    }
    return calls.length === 0 ||
      answers.toSorted().join(",") === calls.join(",")
      ? []
      : [`${calls.join(",")} answered by [${answers.join(",")}]`];
  });
};

const stepOfStoredCall = (part: ChatPart | undefined): string | undefined =>
  part?.type === "tool-call" && "metadata" in part
    ? toolCallStepOf(part.metadata)
    : undefined;

describe("a step whose every call was denied, followed by a step that opens with a call", () => {
  test("answers each call right after its own step in every request", async () => {
    const question = user("user-1", "Delete the NDA");
    const asked = await runAndStore({
      history: [question],
      turns: [stepWithCall("", "call-1")],
    });
    const afterDenial = await runAndStore({
      history: [question, withApprovalAnswer(asked.stored, "call-1", false)],
      resumedMessageId: STORED_ASSISTANT_ID,
      turns: [stepWithCall("", "call-2")],
    });
    // The fixture must reach the fault: nothing but the step each call
    // records separates the denied step from the next one.
    const [denied, next] = afterDenial.stored.parts;
    expect(afterDenial.stored.parts.map((part) => part.type)).toEqual([
      "tool-call",
      "tool-call",
      "tool-result",
    ]);
    expect(afterDenial.stored.parts.at(-1)).toMatchObject({
      type: "tool-result",
      toolCallId: "call-1",
      outcome: "denied",
      state: "error",
      content: JSON.stringify({
        approved: false,
        message: "User denied this action",
      }),
    });
    expect(stepOfStoredCall(denied)).toBeString();
    expect(stepOfStoredCall(next)).toBeString();
    expect(stepOfStoredCall(next)).not.toBe(stepOfStoredCall(denied));

    const afterApproval = await runAndStore({
      history: [
        question,
        withApprovalAnswer(afterDenial.stored, "call-2", true),
      ],
      resumedMessageId: STORED_ASSISTANT_ID,
      turns: [answer("Deleted.")],
    });
    const nextTurn = await runAndStore({
      history: [question, afterApproval.stored, user("user-2", "Thanks")],
      turns: [answer("You're welcome.")],
    });
    const prompts = [
      ...asked.prompts,
      ...afterDenial.prompts,
      ...afterApproval.prompts,
      ...nextTurn.prompts,
    ];

    expect(prefixBreaks(prompts)).toEqual([]);
    expect(prompts.flatMap(unansweredCalls)).toEqual([]);
  });
});
