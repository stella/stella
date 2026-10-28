import { EventType, StreamProcessor } from "@tanstack/ai/client";
import type { UIMessage } from "@tanstack/ai/client";
import { expect, test } from "bun:test";

import {
  buildToolApprovalInterrupt,
  buildWireSnapshot,
} from "@/features/chat/chat-test-fixtures";

const TOOL_CALL_ID = "pending-call";
const APPROVAL_ID = "pending-approval";
const OWNER_ID = "tool-owner";
const TOOL_NAME = "save_record";

test("approval updates the tool owner after a snapshot and later assistant activity", () => {
  for (const snapshot of [false, true]) {
    for (const activity of [
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_CONTENT,
    ] as const) {
      const approvals: string[] = [];
      const processor = new StreamProcessor({
        initialMessages: [
          {
            id: "history",
            role: "assistant",
            parts: [{ type: "text", content: "Earlier answer" }],
          },
        ],
        events: {
          onApprovalRequest: ({ toolCallId }) => {
            approvals.push(toolCallId);
          },
        },
      });
      processor.processChunk({
        type: EventType.RUN_STARTED,
        threadId: "approval-thread",
        runId: "approval-run",
      });
      processor.processChunk({
        type: EventType.TEXT_MESSAGE_START,
        messageId: OWNER_ID,
        role: "assistant",
      });
      processor.processChunk({
        type: EventType.TOOL_CALL_START,
        parentMessageId: OWNER_ID,
        toolCallId: TOOL_CALL_ID,
        toolCallName: TOOL_NAME,
      });
      processor.processChunk({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: TOOL_CALL_ID,
        delta: '{"title":"Record"}',
      });
      processor.processChunk({
        type: EventType.TOOL_CALL_END,
        toolCallId: TOOL_CALL_ID,
      });
      processor.processChunk({
        type: EventType.TEXT_MESSAGE_END,
        messageId: OWNER_ID,
      });
      if (snapshot) {
        processor.processChunk(buildWireSnapshot(processor.getMessages()));
      }
      switch (activity) {
        case EventType.TEXT_MESSAGE_CONTENT:
          processor.processChunk({
            type: EventType.TEXT_MESSAGE_START,
            messageId: "later-answer",
            role: "assistant",
          });
          processor.processChunk({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "later-answer",
            delta: "Waiting",
          });
          break;
        case EventType.REASONING_MESSAGE_CONTENT:
          if (!snapshot) {
            processor.processChunk({
              type: EventType.TEXT_MESSAGE_START,
              messageId: "later-answer",
              role: "assistant",
            });
          }
          processor.processChunk({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: "later-step",
            delta: "",
          });
          break;
      }
      const before = processor.getMessages();
      const owner = before.find(({ id }) => id === OWNER_ID);
      expect(before.at(-1)?.id).not.toBe(OWNER_ID);
      expect(
        owner?.parts.find((part) => part.type === "tool-call")?.state,
      ).toBe("input-complete");
      processor.processChunk({
        type: EventType.RUN_FINISHED,
        threadId: "approval-thread",
        runId: "approval-run",
        outcome: {
          type: "interrupt",
          interrupts: [
            buildToolApprovalInterrupt({
              id: APPROVAL_ID,
              runId: "approval-run",
              toolCallId: TOOL_CALL_ID,
              toolName: TOOL_NAME,
              input: { title: "Record" },
            }),
          ],
        },
      });
      const after = processor.getMessages();
      const approvedOwner = after.find(({ id }) => id === OWNER_ID);
      expect(approvedOwner).not.toBe(owner);
      expect(
        approvedOwner?.parts.find((part) => part.type === "tool-call"),
      ).toMatchObject({
        id: TOOL_CALL_ID,
        state: "approval-requested",
        approval: { id: APPROVAL_ID, needsApproval: true },
      });
      for (const message of before) {
        if (message.id !== OWNER_ID) {
          expect(after.find(({ id }) => id === message.id)).toBe(message);
          expect(after.find(({ id }) => id === message.id)?.parts).toBe(
            message.parts,
          );
        }
      }
      expect(approvals).toEqual([TOOL_CALL_ID]);
    }
  }
});

test("an approval for an absent tool leaves every message unchanged", () => {
  const history = [
    {
      id: OWNER_ID,
      role: "assistant",
      parts: [{ type: "text", content: "No matching tool" }],
    },
  ] satisfies UIMessage[];
  const approvals: string[] = [];
  const processor = new StreamProcessor({
    initialMessages: history,
    events: {
      onApprovalRequest: ({ toolCallId }) => {
        approvals.push(toolCallId);
      },
    },
  });
  processor.processChunk({
    type: EventType.TEXT_MESSAGE_START,
    messageId: OWNER_ID,
    role: "assistant",
  });
  const before = processor.getMessages();
  processor.processChunk({
    type: EventType.RUN_FINISHED,
    runId: "missing-tool-run",
    threadId: "missing-tool-thread",
    outcome: {
      type: "interrupt",
      interrupts: [
        buildToolApprovalInterrupt({
          id: APPROVAL_ID,
          runId: "missing-tool-run",
          toolCallId: TOOL_CALL_ID,
          toolName: TOOL_NAME,
          input: { title: "Record" },
        }),
      ],
    },
  });
  expect(processor.getMessages()).toEqual(before);
  for (const [index, message] of before.entries()) {
    expect(processor.getMessages().at(index)).toBe(message);
    expect(processor.getMessages().at(index)?.parts).toBe(message.parts);
  }
  expect(approvals).toEqual([TOOL_CALL_ID]);
});
