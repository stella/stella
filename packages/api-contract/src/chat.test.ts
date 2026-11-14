import type { ToolCallState } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { CHAT_TOOL_DECLINED_ERROR, isDeclinedChatToolCall } from "./chat";

// Every state a call can be read in. Typed against the engine's state union,
// so a state the engine adds must be listed here before this compiles.
const TOOL_CALL_STATES = {
  "approval-requested": true,
  "approval-responded": true,
  "awaiting-input": true,
  complete: true,
  error: true,
  "input-complete": true,
  "input-streaming": true,
} as const satisfies Record<ToolCallState, true>;

const states = Object.keys(TOOL_CALL_STATES);

const callIn = (state: string, approved?: boolean) => ({
  approval: {
    id: "approval_call-1",
    needsApproval: true,
    ...(approved === undefined ? {} : { approved }),
  },
  id: "call-1",
  state,
  type: "tool-call",
});

describe("a declined chat tool call", () => {
  test("is the user's denial, in every state a call is read in", () => {
    for (const state of states) {
      expect(isDeclinedChatToolCall(callIn(state, false))).toBe(true);
    }
  });

  test("is not an approval, an unanswered call or a call without one", () => {
    for (const state of states) {
      expect(isDeclinedChatToolCall(callIn(state, true))).toBe(false);
      expect(isDeclinedChatToolCall(callIn(state))).toBe(false);
      const withoutApproval = { state, type: "tool-call" };
      expect(isDeclinedChatToolCall(withoutApproval)).toBe(false);
    }
  });

  test("reads the shape a denial is stored in and the shape threads stored before it", () => {
    // As the engine writes a denial, and as `declineToolCall` stores one.
    const stored = {
      ...callIn("error", false),
      output: { error: CHAT_TOOL_DECLINED_ERROR },
    };
    // As threads stored before declined calls settled as errors keep them.
    const earlier = callIn("approval-responded", false);
    expect([stored, earlier].map(isDeclinedChatToolCall)).toEqual([true, true]);
  });

  test("is only ever a tool call", () => {
    expect(
      isDeclinedChatToolCall({
        approval: { approved: false },
        type: "tool-result",
      }),
    ).toBe(false);
  });
});
