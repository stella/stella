import type { ToolCallState } from "@tanstack/ai";
import { panic } from "better-result";

import {
  ASK_USER_TOOL_NAME,
  chatToolExecutor,
  type ChatTurnInteractionType,
  isBrowserResolvedChatToolCall,
  isHarnessChatToolCall,
} from "./chat";
import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "./chat-local-run-question";
import { isUserInputChatToolName } from "./chat-tool-activity";
import { ownEntry } from "./own-key";

/**
 * The one definition of what a turn waits on. The API stores a turn as
 * `awaiting-user` with the first wait this finds; the web keeps a runtime and
 * its cards for the waits the member answers; the phone draws its cards for
 * the same. A new kind of wait added here reaches all three.
 */

/** One call a turn waits on, as the turn row records it. */
export type ChatMemberWait = {
  readonly type: ChatTurnInteractionType;
  readonly toolCallId: string;
};

/**
 * Whether a client-executed call in this state still awaits its client
 * resolution. Input readiness alone cannot identify its executor: sequential
 * server calls can remain input-complete behind an unanswered approval.
 */
const CLIENT_CALL_STATE_AWAITS_RESOLUTION = {
  "approval-requested": false,
  // Only an approved client-executed call: `isApprovedClientCallAwaitingResult`.
  "approval-responded": false,
  // A terminal stream can end while the provider has only announced a call or
  // is still emitting its JSON arguments. Neither state carries usable input,
  // so neither may take durable turn ownership.
  "awaiting-input": false,
  complete: false,
  error: false,
  "input-complete": true,
  "input-streaming": false,
} as const satisfies Record<ToolCallState, boolean>;

/** A stored or streamed tool call, as much of it as these rules read. */
type ToolCallView = {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly approved: boolean | undefined;
  readonly hasOutput: boolean;
};

const toolCallViewOf = (part: unknown): ToolCallView | null => {
  if (typeof part !== "object" || part === null) {
    return null;
  }
  const type: unknown = Reflect.get(part, "type");
  const id: unknown = Reflect.get(part, "id");
  const name: unknown = Reflect.get(part, "name");
  const state: unknown = Reflect.get(part, "state");
  if (
    type !== "tool-call" ||
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof state !== "string"
  ) {
    return null;
  }
  const approval: unknown = Reflect.get(part, "approval");
  const approved: unknown =
    typeof approval === "object" && approval !== null
      ? Reflect.get(approval, "approved")
      : undefined;
  return {
    id,
    name,
    state,
    approved: typeof approved === "boolean" ? approved : undefined,
    hasOutput: Reflect.get(part, "output") !== undefined,
  };
};

const clientCallAwaitsResolution = (state: string): boolean =>
  ownEntry(CLIENT_CALL_STATE_AWAITS_RESOLUTION, state) === true;

/**
 * An approved client-executed call whose result has not arrived. Resuming the
 * approval hands the call to the client, so it stays `approval-responded` with
 * input only until the client posts its result.
 */
export const isApprovedClientCallAwaitingResult = (part: unknown): boolean => {
  const call = toolCallViewOf(part);
  return (
    call !== null &&
    call.state === "approval-responded" &&
    call.approved === true &&
    !call.hasOutput &&
    chatToolExecutor(part) === "client"
  );
};

/** What `part` makes its turn wait on, or null when it waits on nothing. */
const memberWaitOfPart = (part: unknown): ChatMemberWait | null => {
  const call = toolCallViewOf(part);
  if (call === null) {
    return null;
  }
  if (call.state === "approval-requested") {
    return { type: "approval", toolCallId: call.id };
  }
  // A blocking question a harness on the member's computer asked: every
  // other harness call is reported with its result, while the question's
  // call stays open until its answer reaches the run.
  if (
    call.state === "input-complete" &&
    call.name === CHAT_LOCAL_RUN_QUESTION_TOOL &&
    isHarnessChatToolCall(part)
  ) {
    return { type: "harness-question", toolCallId: call.id };
  }
  if (
    (clientCallAwaitsResolution(call.state) &&
      isBrowserResolvedChatToolCall(part)) ||
    isApprovedClientCallAwaitingResult(part)
  ) {
    return {
      type: call.name === ASK_USER_TOOL_NAME ? "ask-user" : "client-tool",
      toolCallId: call.id,
    };
  }
  return null;
};

/**
 * Whether only the member can answer what `part` waits on: an approval, a
 * question, or a card that asks them for input. A client-run step the app
 * resolves on its own (a document tool, an approved client call) waits on
 * the app, not on the member.
 */
export const isMemberAnsweredPart = (part: unknown): boolean => {
  const wait = memberWaitOfPart(part);
  if (wait === null) {
    return false;
  }
  switch (wait.type) {
    case "approval":
    case "ask-user":
    case "harness-question":
      return true;
    case "client-tool":
      return (
        !isApprovedClientCallAwaitingResult(part) &&
        isUserInputChatToolName(toolCallViewOf(part)?.name ?? "")
      );
    default:
      wait.type satisfies never;
      return panic(`Unhandled chat turn wait: ${String(wait.type)}`);
  }
};

/** A message, as much of it as tells whether its turn waits. */
type MemberWaitMessage = {
  readonly role: string;
  readonly metadata?: unknown;
  readonly parts: readonly unknown[];
};

const turnOutcomeTypeOf = (metadata: unknown): unknown => {
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const outcome: unknown = Reflect.get(metadata, "turnOutcome");
  return typeof outcome === "object" && outcome !== null
    ? Reflect.get(outcome, "type")
    : undefined;
};

/**
 * Everything `message` waits on, in part order. Every call that waits stays
 * actionable: a turn is owned by its assistant message, not by whichever
 * wait arrived first in the stream. A message whose turn settled some other
 * way waits on nothing.
 */
export const memberWaitsOf = (
  message: MemberWaitMessage | null | undefined,
): ChatMemberWait[] => {
  if (message?.role !== "assistant") {
    return [];
  }
  const outcome = turnOutcomeTypeOf(message.metadata);
  if (outcome !== undefined && outcome !== "awaiting-user") {
    return [];
  }
  return message.parts.flatMap((part) => {
    const wait = memberWaitOfPart(part);
    return wait === null ? [] : [wait];
  });
};
