import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { expect, test } from "bun:test";

import {
  CHAT_TOOL_DECLINED_ERROR,
  isDeclinedChatToolCall,
} from "@stll/api-contract/chat";

import { declineToolCall } from "@/api/handlers/chat/chat-message-parts";
import { keepDeniedApprovalsOnScreen } from "@/api/handlers/chat/stream-message-identity";
import type { ChatPart } from "@/api/handlers/chat/types";
import { unsafeFixture } from "@/api/tests/helpers/chat-fixtures";

const stream = async function* (chunk: StreamChunk) {
  yield chunk;
};

const collect = async (
  source: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
};

test("denial restoration preserves reconciled results across repeated snapshot passes", async () => {
  const approval = { approved: false, id: "approval-1", needsApproval: true };
  const parts = [
    {
      approval,
      arguments: "{}",
      id: "call-1",
      input: {},
      name: "delete_document",
      output: { error: CHAT_TOOL_DECLINED_ERROR },
      state: "error",
      type: "tool-call",
    },
    {
      content: JSON.stringify({ error: CHAT_TOOL_DECLINED_ERROR }),
      error: CHAT_TOOL_DECLINED_ERROR,
      state: "error",
      toolCallId: "call-1",
      type: "tool-result",
    },
  ] as const satisfies UIMessage["parts"];
  const message = {
    content: "",
    id: "assistant-1",
    parts,
    role: "assistant" as const,
    toolCalls: [
      {
        function: { arguments: "{}", name: "delete_document" },
        id: "call-1",
        type: "function" as const,
      },
    ],
  };
  const snapshot = unsafeFixture(
    "Reconciled denial snapshots carry server UI parts and wire tool calls beyond the engine serializer output",
    {
      messages: [message],
      type: EventType.MESSAGES_SNAPSHOT,
    } as const satisfies StreamChunk,
  );
  const deniedApprovals = new Map([["call-1", approval]]);
  const restored = keepDeniedApprovalsOnScreen({
    deniedApprovals,
    source: keepDeniedApprovalsOnScreen({
      deniedApprovals,
      source: stream(snapshot),
    }),
  });
  const processor = new StreamProcessor();
  for await (const chunk of restored) {
    expect(chunk).toEqual(snapshot);
    processor.processChunk(chunk);
  }
  expect(processor.getMessages().at(0)?.parts).toEqual(parts);
});

/** What a reader sees of a call: its state, decision and output. */
const callView = (part: unknown) => {
  if (
    typeof part !== "object" ||
    part === null ||
    Reflect.get(part, "type") !== "tool-call"
  ) {
    return null;
  }
  return {
    approval: Reflect.get(part, "approval"),
    id: Reflect.get(part, "id"),
    output: Reflect.get(part, "output"),
    state: Reflect.get(part, "state"),
  };
};

test("a denied call rebuilt from the engine's snapshot carries the shape the thread stores", async () => {
  const pending = {
    approval: { id: "approval_call-1", needsApproval: true },
    arguments: '{"name":"NDA"}',
    id: "call-1",
    input: { name: "NDA" },
    name: "mcp__external__delete",
    state: "approval-requested",
    type: "tool-call",
  } as const satisfies ChatPart;
  // What a reload serves for the call once the user declined it.
  const stored = declineToolCall(pending, pending.approval);
  const approval = { ...pending.approval, approved: false };
  // The engine's snapshot after the denial: the call in model form, answered
  // by the denial's tool message.
  const snapshot = unsafeFixture(
    "An engine snapshot pairs a model-form call with the tool message the engine wrote for its denial",
    {
      messages: [
        {
          content: "",
          id: "assistant-1",
          role: "assistant",
          toolCalls: [
            {
              function: { arguments: pending.arguments, name: pending.name },
              id: pending.id,
              type: "function",
            },
          ],
        },
        {
          // The text the engine's tool message carries for its denial.
          content: JSON.stringify({ error: CHAT_TOOL_DECLINED_ERROR }),
          error: CHAT_TOOL_DECLINED_ERROR,
          id: "tool-1",
          role: "tool",
          toolCallId: pending.id,
        },
      ],
      type: EventType.MESSAGES_SNAPSHOT,
    } as const satisfies StreamChunk,
  );

  const [wire] = await collect(
    keepDeniedApprovalsOnScreen({
      deniedApprovals: new Map([[pending.id, approval]]),
      source: stream(snapshot),
    }),
  );
  if (wire?.type !== EventType.MESSAGES_SNAPSHOT) {
    throw new Error("Expected the snapshot back");
  }
  const assistant = wire.messages.at(0);
  const rawParts: unknown =
    assistant === undefined ? undefined : Reflect.get(assistant, "parts");
  const wireParts: readonly unknown[] = Array.isArray(rawParts) ? rawParts : [];
  const expected = callView(stored.call);
  // The fixture reaches the fault: the stored call is settled and declined.
  expect(isDeclinedChatToolCall(stored.call)).toBe(true);
  expect(expected?.state).toBe("error");

  // The wire carries the call as stored, and so does the page that folds it.
  expect(wireParts.map(callView).filter(Boolean)).toEqual([expected]);
  const processor = new StreamProcessor();
  processor.processChunk(wire);
  const folded = processor.getMessages().flatMap(({ parts }) => parts);
  expect(folded.map(callView).filter(Boolean)).toEqual([expected]);
  expect(
    folded.flatMap((part) =>
      part.type === "tool-result"
        ? [{ error: part.error, state: part.state }]
        : [],
    ),
  ).toEqual([{ error: stored.result.error, state: stored.result.state }]);
});
