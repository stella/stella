import { describe, expect, test } from "bun:test";

import { isChatPart } from "@/api/handlers/chat/chat-message-parts";
import { isRevisionToolCallSettled } from "@/api/handlers/chat/messages/revisions/revision-settlement";
import type { ChatPart } from "@/api/handlers/chat/types";

const states = {
  "awaiting-input": { state: "awaiting-input", settled: false },
  "input-streaming": { state: "input-streaming", settled: false },
  "input-complete": { state: "input-complete", settled: false },
  "approval-requested": { state: "approval-requested", settled: false },
  "approval-responded": { state: "approval-responded", settled: true },
  complete: { state: "complete", settled: true },
  error: { state: "error", settled: true },
} as const satisfies Record<
  Extract<ChatPart, { type: "tool-call" }>["state"],
  { state: Extract<ChatPart, { type: "tool-call" }>["state"]; settled: boolean }
>;

const settledCall = (value: unknown) => {
  if (!isChatPart(value) || value.type !== "tool-call") {
    throw new TypeError("Expected a valid tool-call fixture");
  }
  return isRevisionToolCallSettled(value);
};

const call = {
  type: "tool-call",
  id: "tool-call",
  name: "mcp__external__search",
  arguments: "{}",
};

describe("answer edit tool settlement", () => {
  test.each(Object.values(states))(
    "$state has settlement $settled",
    ({ state, settled }) => {
      expect(
        settledCall({
          ...call,
          state,
          approval: { id: "approval", needsApproval: true, approved: false },
        }),
      ).toBe(settled);
    },
  );

  test.each([true, undefined])(
    "an approval response of %s still awaits execution",
    (approved) => {
      expect(
        settledCall({
          ...call,
          state: "approval-responded",
          approval: { id: "approval", needsApproval: true, approved },
        }),
      ).toBe(false);
    },
  );
});
