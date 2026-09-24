import { TaggedError } from "better-result";

import type { ChatPart, ChatTurnOutcome } from "@/api/handlers/chat/types";

type ToolCallPart = Extract<ChatPart, { type: "tool-call" }>;
export type ToolCallState = ToolCallPart["state"];
type OutcomeType = ChatTurnOutcome["type"];

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

/**
 * Which open tool-call states a message may keep once its turn ends that way.
 * A completed turn keeps none. A turn awaiting the user keeps what the user
 * can answer. A turn that stopped early may keep calls whose input or answer
 * never arrived, but never an approved call without its result: that call ran,
 * or runs again on the next turn.
 */
const OPEN_STATE_ALLOWED = {
  none: {
    "approval-requested": false,
    "approval-responded": false,
    "awaiting-input": false,
    complete: false,
    error: false,
    "input-complete": false,
    "input-streaming": false,
  },
  "client-answerable": CLIENT_ANSWERABLE_TOOL_CALL_STATE,
  stopped: {
    "approval-requested": true,
    "approval-responded": false,
    "awaiting-input": true,
    complete: false,
    error: false,
    "input-complete": true,
    "input-streaming": true,
  },
} as const satisfies Record<string, Record<ToolCallState, boolean>>;

type OpenCallPolicy = keyof typeof OPEN_STATE_ALLOWED;

const OUTCOME_POLICY = {
  "awaiting-user": "client-answerable",
  cancelled: "stopped",
  completed: "none",
  failed: "stopped",
  interrupted: "stopped",
} as const satisfies Record<OutcomeType, OpenCallPolicy>;

const SETTLED_TOOL_CALL_STATE = {
  "approval-requested": false,
  "approval-responded": false,
  "awaiting-input": false,
  complete: true,
  error: true,
  "input-complete": false,
  "input-streaming": false,
} as const satisfies Record<ToolCallState, boolean>;

/** A call is settled once its result or error is stored, or its approval was
 *  denied. */
const isSettledToolCall = (part: ToolCallPart): boolean =>
  SETTLED_TOOL_CALL_STATE[part.state] ||
  ("approval" in part && part.approval.approved === false);

export type UnsettledToolCall = {
  state: ToolCallState;
  toolCallId: string;
};

const findUnsettled = (
  policy: OpenCallPolicy,
  parts: readonly ChatPart[],
): UnsettledToolCall[] =>
  parts.flatMap((part) =>
    part.type === "tool-call" &&
    !isSettledToolCall(part) &&
    !OPEN_STATE_ALLOWED[policy][part.state]
      ? [{ state: part.state, toolCallId: part.id }]
      : [],
  );

/**
 * The tool calls on a turn's terminal assistant message that the way the turn
 * ended does not allow to stay open. Empty for a sound turn.
 */
export const findUnsettledToolCallsForOutcome = ({
  outcome,
  parts,
}: {
  outcome: OutcomeType;
  parts: readonly ChatPart[];
}): UnsettledToolCall[] => findUnsettled(OUTCOME_POLICY[outcome], parts);

/**
 * The tool calls a continuation left open on the message it resumed, when the
 * turn's output went to another message. Whatever that turn awaits sits on its
 * own message, so the resumed one keeps nothing for the user to answer.
 */
export const findUnsettledToolCallsOnResumedMessage = ({
  outcome,
  parts,
}: {
  outcome: OutcomeType;
  parts: readonly ChatPart[];
}): UnsettledToolCall[] => {
  const policy = OUTCOME_POLICY[outcome];
  return findUnsettled(policy === "client-answerable" ? "none" : policy, parts);
};

/** Reported, never thrown: a settled turn stored a tool call without its
 *  final disposition. */
export class ChatTurnUnsettledToolCallError extends TaggedError(
  "ChatTurnUnsettledToolCallError",
)<{
  message: string;
}> {}
