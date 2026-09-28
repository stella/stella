import { uiMessageToModelMessages } from "@tanstack/ai";
import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import {
  cancelPendingChatToolCalls,
  getAwaitingUserInteractions,
  isChatPart,
} from "@/api/handlers/chat/chat-message-parts";
import type { AwaitingUserInteraction } from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatMessage,
  ChatPart,
  ChatTurnOutcome,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { guardModelMessages } from "@/api/lib/chat/model-ingress-guard";
import type { GuardedModelMessages } from "@/api/lib/chat/model-ingress-guard";

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
 * Which open tool-call states a run may leave on its message once its turn
 * ends that way. A completed turn leaves none. A turn awaiting the user leaves
 * what the user can answer. A turn that stopped early may leave calls whose
 * input or answer never arrived, but never an approved call without its
 * result: that call ran, or runs again on the next turn. What the stored
 * message keeps is `findUnsettledStoredToolCalls`.
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

/**
 * Outcomes that cut a run off mid-stream: a dropped connection, a deadline,
 * or the user's stop. The message keeps the tool input streamed so far, and
 * its stored form closes every call that can no longer run or be answered
 * (`closeCutShortCalls`): no later turn runs it or asks about it again.
 */
export const CUT_SHORT_OUTCOME = {
  "awaiting-user": false,
  cancelled: true,
  completed: false,
  failed: false,
  interrupted: true,
} as const satisfies Record<OutcomeType, boolean>;

type CutShortOutcomeType = {
  [TType in OutcomeType]: (typeof CUT_SHORT_OUTCOME)[TType] extends true
    ? TType
    : never;
}[OutcomeType];

export type CutShortOutcome = Extract<
  ChatTurnOutcome,
  { type: CutShortOutcomeType }
>;

export const isCutShortOutcome = (
  outcome: ChatTurnOutcome,
): outcome is CutShortOutcome => CUT_SHORT_OUTCOME[outcome.type];

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
 * The tool calls on a turn's terminal assistant message, as the run produced
 * it, that the way the turn ended does not allow to stay open. Empty for a
 * sound turn.
 */
export const findUnsettledToolCallsForOutcome = ({
  outcome,
  parts,
}: {
  outcome: OutcomeType;
  parts: readonly SettlementPart[];
}): UnsettledToolCall[] => findUnsettled(OUTCOME_POLICY[outcome], parts);

/**
 * The tool calls a stored message holds open that the way its turn ended does
 * not allow: what `findUnsettledToolCallsForOutcome` allows, less what
 * settlement closes. A cut-short turn's stored message keeps none. Empty for
 * a sound stored thread.
 */
export const findUnsettledStoredToolCalls = ({
  outcome,
  parts,
}: {
  outcome: OutcomeType;
  parts: readonly SettlementPart[];
}): UnsettledToolCall[] =>
  findUnsettled(
    CUT_SHORT_OUTCOME[outcome] ? "none" : OUTCOME_POLICY[outcome],
    parts,
  );

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

/**
 * A cut-short turn's message as stored: a call whose input or answer never
 * arrived is closed as an error, an approval nobody answered as declined
 * (`cancelPendingChatToolCalls`), and an approved call without its result as
 * unfinished.
 */
export const closeCutShortCalls = <TMessage extends PersistableChatMessage>(
  message: TMessage,
): TMessage => {
  const closed = cancelPendingChatToolCalls(message);
  return {
    ...message,
    parts: settleOpenToolCallsForOutcome({
      outcome: "interrupted",
      parts: closed.parts,
    }),
  };
};

/**
 * The interaction a run that ended waits on: the first call its message holds
 * open for the user among the interrupts the run handed out. The engine hands
 * one out only for a call that needs approval or that no server `execute`
 * runs, and only once its step is done, so a server call whose input
 * completed but which never ran, or an approval the run was cut off before
 * announcing, never waits on the user.
 */
export const findHandedOutInteraction = ({
  interruptToolCallIds,
  message,
}: {
  interruptToolCallIds: ReadonlySet<string>;
  message: Pick<ChatMessage, "parts" | "role"> | null;
}): AwaitingUserInteraction | null =>
  getAwaitingUserInteractions(message).find(({ toolCallId }) =>
    interruptToolCallIds.has(toolCallId),
  ) ?? null;

/**
 * The history a run hands the engine. Only the message a continuation resumes
 * may hold open calls for this run to execute or the client to answer; an
 * open call anywhere else belongs to a turn that already ended. The results
 * that close those calls exist only for the engine: the client-visible
 * stream presents every earlier message as stored (`presentStoredHistory`).
 */
export const settleHistoryForRun = ({
  messages,
  resumedMessageId,
}: {
  messages: readonly ChatMessage[];
  resumedMessageId: string | undefined;
}): ChatMessage[] =>
  messages.map((message) => {
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
    return settled ? { ...message, parts } : message;
  });

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

type ToolResultPart = Extract<ChatPart, { type: "tool-result" }>;

/**
 * The answer the SDK gives a call that holds no result part (a denial, an
 * approval still to run, an output kept on the call), read from the SDK's
 * own conversion so it stays byte for byte what the SDK sends. Undefined when
 * the SDK gives the call no answer.
 */
const trailingAnswerOf = (call: ToolCallPart): ToolResultPart | undefined => {
  const answer = uiMessageToModelMessages({
    id: call.id,
    parts: [call],
    role: "assistant",
  }).find(
    (message) => message.role === "tool" && message.toolCallId === call.id,
  );
  return answer === undefined || typeof answer.content !== "string"
    ? undefined
    : {
        content: answer.content,
        state: "complete",
        toolCallId: call.id,
        type: "tool-result",
      };
};

const carriesApproval = (part: ChatPart | undefined): boolean =>
  part?.type === "tool-call" && "approval" in part;

/**
 * Where the answer to the call at `callIndex` belongs: among its step's
 * results, the tool results right after the step's calls. The request that
 * answered the call sent the step's results stored by then, and after them,
 * in call order, the answers to the step's approvals; an approved call's
 * result is stored later, in place of its answer. So the answer goes before
 * the first stored result of an approval call made after it, else after the
 * step's results: `parts.length` when the step ends the message.
 */
const answerIndexInStep = (
  parts: readonly ChatPart[],
  callIndex: number,
): number => {
  let end = callIndex + 1;
  while (parts[end]?.type === "tool-call") {
    end += 1;
  }
  const resultsStart = end;
  while (parts[end]?.type === "tool-result") {
    end += 1;
  }
  for (let index = resultsStart; index < end; index += 1) {
    const result = parts[index];
    const answered =
      result?.type === "tool-result"
        ? parts.findIndex(
            (part) =>
              part.type === "tool-call" && part.id === result.toolCallId,
          )
        : -1;
    if (answered > callIndex && carriesApproval(parts[answered])) {
      return index;
    }
  }
  return end;
};

/**
 * `parts` with each call the SDK answers only at the end of the message (a
 * denial, most often) answered in its own step instead. The SDK appends those
 * answers after the whole message, so once the message goes on past the
 * call's step a provider sees the call without its answer after it, and a
 * request rebuilt from the thread no longer begins with the request that
 * answered the call. Only the provider request reads this: the stored
 * message keeps its parts. Idempotent; returns `parts` when nothing moves.
 */
export const answerCallsInTheirStep = (
  parts: readonly ChatPart[],
): readonly ChatPart[] => {
  const answeredIds = new Set(
    parts.flatMap((part) =>
      part.type === "tool-result" && part.state !== "streaming"
        ? [part.toolCallId]
        : [],
    ),
  );
  // Each answer with the index of the part it goes before, in call order.
  const answers: { answer: ToolResultPart; at: number }[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.type !== "tool-call" || answeredIds.has(part.id)) {
      continue;
    }
    const answer = trailingAnswerOf(part);
    const at = answerIndexInStep(parts, index);
    // A step that ends the message already has the SDK's answers after it.
    if (answer !== undefined && at < parts.length) {
      answers.push({ answer, at });
    }
  }
  return answers.length === 0
    ? parts
    : parts.flatMap((part, index) => [
        ...answers.flatMap(({ answer, at }) => (at === index ? [answer] : [])),
        part,
      ]);
};

/** `messages` with every assistant message's calls answered in their own
 *  step (`answerCallsInTheirStep`), for a provider request. */
const answerHistoryCallsInTheirStep = (
  messages: readonly ChatMessage[],
): ChatMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const parts = answerCallsInTheirStep(message.parts);
    return parts === message.parts
      ? message
      : { ...message, parts: [...parts] };
  });

const providerHistorySchema = v.pipe(
  v.custom<GuardedModelMessages<ChatMessage[]>>(Array.isArray),
  v.brand("GuardedProviderHistory"),
);

/** The history a chat attempt hands the provider. Mintable only by
 *  `guardProviderHistory`, so a history that skipped it fails typecheck at
 *  the dispatch. */
export type GuardedProviderHistory = v.InferOutput<
  typeof providerHistorySchema
>;

/**
 * The provider's copy of `messages`: every call answered right after its
 * step, then run through the model-ingress guard, so the answers it adds pass
 * the guard like everything else the provider reads.
 */
export const guardProviderHistory = ({
  messages,
  workspaceIds,
}: {
  messages: readonly ChatMessage[];
  workspaceIds: readonly SafeId<"workspace">[];
}): GuardedProviderHistory =>
  v.parse(
    providerHistorySchema,
    guardModelMessages({
      messages: answerHistoryCallsInTheirStep(messages),
      workspaceIds,
    }),
  );
