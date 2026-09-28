import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyTextAdapter, ModelMessage } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  answerCallsInTheirStep,
  answerHistoryCallsInTheirStep,
  settleHistoryForRun,
} from "@/api/handlers/chat/chat-turn-settlement";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import {
  scriptedAdapterBase,
  scriptedTurnChunks,
} from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";

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
  const messages = answerHistoryCallsInTheirStep(
    settleHistoryForRun({ messages: history, resumedMessageId }),
  );
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
