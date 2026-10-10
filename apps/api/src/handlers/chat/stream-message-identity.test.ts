import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { expect, test } from "bun:test";

import { keepDeniedApprovalsOnScreen } from "@/api/handlers/chat/stream-message-identity";
import { unsafeFixture } from "@/api/tests/helpers/chat-fixtures";

const stream = async function* (chunk: StreamChunk) {
  yield chunk;
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
      output: { error: "User declined tool execution" },
      state: "error",
      type: "tool-call",
    },
    {
      content: '{"error":"User declined tool execution"}',
      error: "User declined tool execution",
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
