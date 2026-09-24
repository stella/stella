import { describe, expect, test } from "bun:test";

import { findUnsettledToolCallsForOutcome } from "@/api/handlers/chat/chat-turn-settlement";
import type { ChatPart, ChatTurnOutcome } from "@/api/handlers/chat/types";

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

const openIds = (outcome: ChatTurnOutcome, parts: ChatPart[]) =>
  findUnsettledToolCallsForOutcome({ outcome, parts }).map(
    ({ toolCallId }) => toolCallId,
  );

describe("tool calls a settled turn may leave open", () => {
  test("a completed turn leaves none: an approved call without its result is reported", () => {
    expect(
      openIds({ type: "completed" }, [
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
      openIds(
        {
          interaction: { toolCallId: "pending", type: "approval" },
          type: "awaiting-user",
        },
        [completed, pendingApproval, approvedWithoutOutput, streaming],
      ),
    ).toEqual(["approved", "streaming"]);
  });

  test.each([
    { type: "cancelled", reason: "user-stop" },
    { type: "failed", error: "unknown" },
    { type: "interrupted", reason: "timeout" },
  ] satisfies ChatTurnOutcome[])(
    "a $type turn may stop with calls mid-flight",
    (outcome) => {
      expect(
        openIds(outcome, [approvedWithoutOutput, streaming, pendingApproval]),
      ).toEqual([]);
    },
  );
});
