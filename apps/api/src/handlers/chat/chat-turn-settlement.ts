import { TaggedError } from "better-result";

import type { ChatPart, ChatTurnOutcome } from "@/api/handlers/chat/types";

type ToolCallPart = Extract<ChatPart, { type: "tool-call" }>;
export type ToolCallState = ToolCallPart["state"];

/** Tool-call states that are a final disposition of the call. */
const SETTLED_TOOL_CALL_STATE = {
  "approval-requested": false,
  "approval-responded": false,
  "awaiting-input": false,
  complete: true,
  error: true,
  "input-complete": false,
  "input-streaming": false,
} as const satisfies Record<ToolCallState, boolean>;

/**
 * Tool-call states a client can still answer from a reloaded thread: an
 * approval prompt, or a client-executed call whose input is complete and whose
 * result the client posts back.
 */
export const CLIENT_ANSWERABLE_TOOL_CALL_STATE = {
  "approval-requested": true,
  "approval-responded": false,
  "awaiting-input": false,
  complete: false,
  error: false,
  "input-complete": true,
  "input-streaming": false,
} as const satisfies Record<ToolCallState, boolean>;

/** A call is settled once its result or error is stored, or its approval was
 *  denied. */
export const isSettledToolCall = (part: ToolCallPart): boolean =>
  SETTLED_TOOL_CALL_STATE[part.state] ||
  ("approval" in part && part.approval.approved === false);

/**
 * Which tool calls a turn with this outcome may leave open on its message. A
 * completed turn leaves none; a turn awaiting the user leaves only what the
 * user can answer; a turn that stopped early may hold calls mid-flight.
 */
const OPEN_CALLS_ALLOWED = {
  "awaiting-user": "client-answerable",
  cancelled: "any",
  completed: "none",
  failed: "any",
  interrupted: "any",
} as const satisfies Record<
  ChatTurnOutcome["type"],
  "any" | "client-answerable" | "none"
>;

export type UnsettledToolCall = {
  state: ToolCallState;
  toolCallId: string;
};

/**
 * The tool calls on a terminal assistant message that its turn outcome does
 * not allow to stay open. Empty for a sound turn.
 */
export const findUnsettledToolCallsForOutcome = ({
  outcome,
  parts,
}: {
  outcome: ChatTurnOutcome;
  parts: readonly ChatPart[];
}): UnsettledToolCall[] => {
  const allowed = OPEN_CALLS_ALLOWED[outcome.type];
  if (allowed === "any") {
    return [];
  }
  return parts.flatMap((part) =>
    part.type === "tool-call" &&
    !isSettledToolCall(part) &&
    !(
      allowed === "client-answerable" &&
      CLIENT_ANSWERABLE_TOOL_CALL_STATE[part.state]
    )
      ? [{ state: part.state, toolCallId: part.id }]
      : [],
  );
};

/**
 * The tool calls a continuation left open on the message it resumed, when the
 * turn's output went to another message. Whatever that turn awaits sits on its
 * own message, so the resumed one must be fully settled.
 */
export const findUnsettledToolCallsOnResumedMessage = ({
  outcome,
  parts,
}: {
  outcome: ChatTurnOutcome;
  parts: readonly ChatPart[];
}): UnsettledToolCall[] =>
  OPEN_CALLS_ALLOWED[outcome.type] === "any"
    ? []
    : findUnsettledToolCallsForOutcome({
        outcome: { type: "completed" },
        parts,
      });

/** Reported, never thrown: a settled turn stored a tool call without its
 *  final disposition. */
export class ChatTurnUnsettledToolCallError extends TaggedError(
  "ChatTurnUnsettledToolCallError",
)<{
  message: string;
}> {}
