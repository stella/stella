import { panic, TaggedError } from "better-result";

import { isChatPart } from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatMessage,
  ChatPart,
  ChatTurnOutcome,
} from "@/api/handlers/chat/types";

type ToolCallPart = Extract<ChatPart, { type: "tool-call" }>;
export type ToolCallState = ToolCallPart["state"];
type OutcomeType = ChatTurnOutcome["type"];

/**
 * The parts these rules read. Every stored `ChatPart` is one; so is a tool
 * call read back over the API, whose tool name the typed part union cannot
 * know in advance.
 */
export type SettlementPart =
  | ChatPart
  | {
      type: "tool-call";
      id: string;
      state: ToolCallState;
      approval?: { approved?: boolean };
    };

type SettlementToolCall = Extract<SettlementPart, { type: "tool-call" }>;

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

const isDeniedCall = (part: SettlementPart): boolean =>
  part.type === "tool-call" &&
  "approval" in part &&
  part.approval.approved === false;

/** A call is settled once its result or error is stored, or its approval was
 *  denied. */
const isSettledToolCall = (part: SettlementToolCall): boolean =>
  SETTLED_TOOL_CALL_STATE[part.state] || isDeniedCall(part);

export type UnsettledToolCall = {
  state: ToolCallState;
  toolCallId: string;
};

const findUnsettled = (
  policy: OpenCallPolicy,
  parts: readonly SettlementPart[],
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
  parts: readonly SettlementPart[];
}): UnsettledToolCall[] => findUnsettled(OUTCOME_POLICY[outcome], parts);

/** What the model and the user see for an approved call whose run ended
 *  without storing its result. */
export const UNFINISHED_APPROVED_CALL_ERROR =
  "This approved action did not finish and its result was not saved. It may have taken effect; check before asking to run it again.";

const hasStoredResult = (
  call: ToolCallPart,
  parts: readonly ChatPart[],
): boolean =>
  ("output" in call && call.output !== undefined) ||
  parts.some(
    (part) =>
      part.type === "tool-result" &&
      part.toolCallId === call.id &&
      part.state !== "streaming",
  );

const isApprovedWithoutResult = (
  part: ToolCallPart,
  parts: readonly ChatPart[],
): boolean =>
  part.state === "approval-responded" &&
  "approval" in part &&
  part.approval.approved === true &&
  !hasStoredResult(part, parts);

/** The call as stored once its run ended: an error whose outcome is unknown.
 *  Each tool types its own output, so the part is checked, not asserted. */
const unfinishedCall = (part: ToolCallPart): ChatPart => {
  const candidate: unknown = {
    ...part,
    output: { error: UNFINISHED_APPROVED_CALL_ERROR },
    state: "error",
  };
  return isChatPart(candidate)
    ? candidate
    : panic("An unfinished tool call must remain a valid chat part");
};

/** The stored result that closes a call with an error. */
export const errorToolResult = (
  toolCallId: string,
  error: string,
): Extract<ChatPart, { type: "tool-result" }> => ({
  content: JSON.stringify({ error }),
  error,
  state: "error",
  toolCallId,
  type: "tool-result",
});

/** What the model sees for a call whose turn ended before a result was
 *  stored: a cancelled clarification the user typed past, an approval never
 *  answered, or a client call cut off by a stop. */
export const UNRESOLVED_CALL_ERROR =
  "This call never returned a result: its turn ended before one was stored.";

/**
 * Which open states the engine reads as a call still waiting on the client
 * once it is handed the call without a result: it then asks the client again
 * instead of running the model. An approval decision is answered by the
 * engine itself (a denial) or already closed by `settleOpenToolCallsForOutcome`
 * (an approval without its result). A call whose input never completed is not
 * handed to the engine at all.
 */
const ENGINE_ASKS_CLIENT_AGAIN = {
  "approval-requested": true,
  "approval-responded": false,
  "awaiting-input": false,
  complete: false,
  error: true,
  "input-complete": true,
  "input-streaming": false,
} as const satisfies Record<ToolCallState, boolean>;

/**
 * Close every call on a message the run does not resume that the engine
 * would otherwise ask the client about again. Such a call belongs to a turn
 * that already ended, so nobody can answer it any more.
 */
const closeUnresolvedCallsForEngine = (
  parts: readonly ChatPart[],
): ChatPart[] =>
  parts.flatMap((part): ChatPart[] =>
    part.type === "tool-call" &&
    ENGINE_ASKS_CLIENT_AGAIN[part.state] &&
    !hasStoredResult(part, parts)
      ? [part, errorToolResult(part.id, UNRESOLVED_CALL_ERROR)]
      : [part],
  );

/**
 * Close the approved calls a turn left without a result once it ended some
 * way other than waiting on the user. The run may have executed them, so they
 * are stored as unfinished, with an unknown outcome. A turn waiting on the
 * user keeps them: the engine holds an approved call back until every
 * approval in its step is answered.
 */
export const settleOpenToolCallsForOutcome = ({
  outcome,
  parts,
}: {
  outcome: OutcomeType;
  parts: readonly ChatPart[];
}): ChatPart[] => {
  if (OUTCOME_POLICY[outcome] === "client-answerable") {
    return [...parts];
  }
  return parts.flatMap((part): ChatPart[] =>
    part.type === "tool-call" && isApprovedWithoutResult(part, parts)
      ? [
          unfinishedCall(part),
          errorToolResult(part.id, UNFINISHED_APPROVED_CALL_ERROR),
        ]
      : [part],
  );
};

/** A run's history: what the engine is handed, and what the client is shown
 *  of it. */
export type RunHistory = {
  engine: ChatMessage[];
  /**
   * Every earlier message the engine reads differently from the stored
   * thread, by id, as stored: one settling closes with results that exist
   * only for the engine, or one holding a denied call, which the engine
   * replays as a result the thread never stores. The client-visible stream
   * presents these as stored (`presentStoredHistory`).
   */
  storedForms: ReadonlyMap<string, ChatMessage>;
};

/**
 * The history a run hands the engine. Only the message a continuation resumes
 * may hold open calls for this run to execute or the client to answer; an
 * open call anywhere else belongs to a turn that already ended.
 */
export const settleHistoryForRun = ({
  messages,
  resumedMessageId,
}: {
  messages: readonly ChatMessage[];
  resumedMessageId: string | undefined;
}): RunHistory => {
  const storedForms = new Map<string, ChatMessage>();
  const engine = messages.map((message) => {
    if (message.role !== "assistant" || message.id === resumedMessageId) {
      return message;
    }
    const parts = closeUnresolvedCallsForEngine(
      settleOpenToolCallsForOutcome({
        outcome: "interrupted",
        parts: message.parts,
      }),
    );
    const settled =
      parts.length !== message.parts.length ||
      parts.some((part, index) => part !== message.parts[index]);
    if (settled || message.parts.some(isDeniedCall)) {
      storedForms.set(message.id, message);
    }
    return settled ? { ...message, parts } : message;
  });
  return { engine, storedForms };
};

export type DroppedParts = {
  droppedToolCallIds: string[];
  partCountDrop: number;
};

/**
 * What a continuation's stored message lost from the message it continued. A
 * continuation adds to that message and settles its calls in place, so every
 * earlier tool call is still there and the message never gets shorter. Null
 * when nothing was lost.
 */
export const findDroppedParts = ({
  continued,
  stored,
}: {
  continued: readonly SettlementPart[];
  stored: readonly SettlementPart[];
}): DroppedParts | null => {
  const storedToolCallIds = new Set(
    stored.flatMap((part) => (part.type === "tool-call" ? [part.id] : [])),
  );
  const droppedToolCallIds = continued.flatMap((part) =>
    part.type === "tool-call" && !storedToolCallIds.has(part.id)
      ? [part.id]
      : [],
  );
  const partCountDrop = Math.max(0, continued.length - stored.length);
  return droppedToolCallIds.length === 0 && partCountDrop === 0
    ? null
    : { droppedToolCallIds, partCountDrop };
};

/** Reported, never thrown: a settled turn stored a tool call without its
 *  final disposition. */
export class ChatTurnUnsettledToolCallError extends TaggedError(
  "ChatTurnUnsettledToolCallError",
)<{
  message: string;
}> {}

/** Reported, never thrown: a continuation stored its message without parts
 *  the message already had. */
export class ChatTurnDroppedPartsError extends TaggedError(
  "ChatTurnDroppedPartsError",
)<{
  message: string;
}> {}
