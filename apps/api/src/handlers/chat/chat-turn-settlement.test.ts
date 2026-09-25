import { describe, expect, test } from "bun:test";

import {
  findDroppedParts,
  findUnsettledToolCallsForOutcome,
  settleHistoryForRun,
  settleOpenToolCallsForOutcome,
  UNFINISHED_APPROVED_CALL_ERROR,
} from "@/api/handlers/chat/chat-turn-settlement";
import type {
  ChatMessage,
  ChatPart,
  ChatTurnOutcome,
} from "@/api/handlers/chat/types";

type ToolCallState = Extract<ChatPart, { type: "tool-call" }>["state"];

// An external MCP tool: its parts carry the approval an approval-gated call
// records.
const call = (
  id: string,
  fields: {
    approval?: { approved?: boolean; id: string; needsApproval: boolean };
    output?: unknown;
    state: ToolCallState;
  },
): ChatPart => ({
  arguments: '{"name":"NDA"}',
  id,
  input: { name: "NDA" },
  name: "mcp__external__delete",
  type: "tool-call",
  ...fields,
});

const approvedWithoutOutput = call("approved", {
  approval: { approved: true, id: "approval_approved", needsApproval: true },
  state: "approval-responded",
});
const denied = call("denied", {
  approval: { approved: false, id: "approval_denied", needsApproval: true },
  state: "approval-responded",
});
const pendingApproval = call("pending", {
  approval: { id: "approval_pending", needsApproval: true },
  state: "approval-requested",
});
const streaming = call("streaming", { state: "input-streaming" });
const completed = call("completed", { output: {}, state: "complete" });
const failed = call("failed", { state: "error" });

const openIds = (outcome: ChatTurnOutcome["type"], parts: ChatPart[]) =>
  findUnsettledToolCallsForOutcome({ outcome, parts }).map(
    ({ toolCallId }) => toolCallId,
  );

describe("tool calls a settled turn may leave open", () => {
  test("a completed turn leaves none: an approved call without its result is reported", () => {
    expect(
      openIds("completed", [
        { content: "Done.", type: "text" },
        completed,
        failed,
        denied,
        approvedWithoutOutput,
        streaming,
      ]),
    ).toEqual(["approved", "streaming"]);
  });

  test("a turn awaiting the user leaves only what the user can answer", () => {
    expect(
      openIds("awaiting-user", [
        completed,
        pendingApproval,
        approvedWithoutOutput,
        streaming,
      ]),
    ).toEqual(["approved", "streaming"]);
  });

  test.each(["cancelled", "failed", "interrupted"] as const)(
    "a %s turn may stop mid-flight, but not on an approved call without its result",
    (outcome) => {
      expect(
        openIds(outcome, [approvedWithoutOutput, streaming, pendingApproval]),
      ).toEqual(["approved"]);
    },
  );
});

describe("parts a continuation may not drop", () => {
  const text = { content: "Deleted.", type: "text" } satisfies ChatPart;

  test("settling a call in place and adding text drops nothing", () => {
    expect(
      findDroppedParts({
        continued: [approvedWithoutOutput],
        stored: [call("approved", { output: {}, state: "complete" }), text],
      }),
    ).toBeNull();
  });

  test("a stored message missing an earlier call reports it", () => {
    expect(
      findDroppedParts({ continued: [completed, failed], stored: [completed] }),
    ).toEqual({ droppedToolCallIds: ["failed"], partCountDrop: 1 });
  });

  test("a stored message shorter than the one it continued reports the drop", () => {
    expect(
      findDroppedParts({ continued: [text, completed], stored: [completed] }),
    ).toEqual({ droppedToolCallIds: [], partCountDrop: 1 });
  });
});

describe("settling the calls a turn left open", () => {
  const unfinished = [
    call("approved", {
      approval: {
        approved: true,
        id: "approval_approved",
        needsApproval: true,
      },
      output: { error: UNFINISHED_APPROVED_CALL_ERROR },
      state: "error",
    }),
    {
      content: JSON.stringify({ error: UNFINISHED_APPROVED_CALL_ERROR }),
      error: UNFINISHED_APPROVED_CALL_ERROR,
      state: "error",
      toolCallId: "approved",
      type: "tool-result",
    },
  ] satisfies ChatPart[];

  test.each(["cancelled", "completed", "failed", "interrupted"] as const)(
    "a %s turn turns an approved call without its result into a stored error",
    (outcome) => {
      const settled = settleOpenToolCallsForOutcome({
        outcome,
        parts: [approvedWithoutOutput, streaming],
      });

      expect(settled).toEqual([...unfinished, streaming]);
      expect(openIds(outcome, settled)).not.toContain("approved");
    },
  );

  test("a turn awaiting the user keeps an approved call the engine held back", () => {
    const parts = [approvedWithoutOutput, pendingApproval];

    expect(
      settleOpenToolCallsForOutcome({ outcome: "awaiting-user", parts }),
    ).toEqual(parts);
  });

  test("calls with a result, a stored error, or a denial stay as they are", () => {
    const resultPart = {
      content: "{}",
      state: "complete",
      toolCallId: "resulted",
      type: "tool-result",
    } satisfies ChatPart;
    const parts = [
      completed,
      failed,
      denied,
      call("resulted", {
        approval: {
          approved: true,
          id: "approval_resulted",
          needsApproval: true,
        },
        state: "approval-responded",
      }),
      resultPart,
    ];

    expect(settleOpenToolCallsForOutcome({ outcome: "failed", parts })).toEqual(
      parts,
    );
  });
});

describe("the history a run hands the engine", () => {
  const assistant = (id: string, parts: ChatPart[]): ChatMessage => ({
    id,
    parts,
    role: "assistant",
  });

  test("only the resumed message keeps its approved calls open", () => {
    const earlier = assistant("earlier", [approvedWithoutOutput]);
    const resumed = assistant("resumed", [approvedWithoutOutput]);

    const history = settleHistoryForRun({
      messages: [earlier, resumed],
      resumedMessageId: "resumed",
    });

    expect(history.map(({ parts }) => parts.length)).toEqual([2, 1]);
    expect(history[1]).toBe(resumed);
  });

  test("a new user turn resumes nothing", () => {
    const history = settleHistoryForRun({
      messages: [assistant("earlier", [approvedWithoutOutput])],
      resumedMessageId: undefined,
    });

    expect(history[0]?.parts.map(({ type }) => type)).toEqual([
      "tool-call",
      "tool-result",
    ]);
  });
});
