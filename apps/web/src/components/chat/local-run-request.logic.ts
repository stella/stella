import { panic } from "better-result";

import {
  type ChatLocalRunRequest,
  chatLocalRunRequestsOf,
} from "@stll/api-contract/chat-local-run-request";

import type { ChatPart } from "@/components/chat/chat-ui-tools-types";

type ToolCallPart = Extract<ChatPart, { type: "tool-call" }>;

/**
 * The request a run on the member's computer asked about call `toolCallId`,
 * in its latest state, from the answer's metadata: the stream restates it
 * there and the stored answer keeps it, so a live and a reloaded answer read
 * the same. `null` for a call no request names.
 */
export const localRunRequestOfCall = (
  metadata: unknown,
  toolCallId: string,
): ChatLocalRunRequest | null =>
  chatLocalRunRequestsOf(metadata).findLast(
    (request) => request.toolCallId === toolCallId,
  ) ?? null;

/**
 * The approvals the run of the latest answer still waits on, by request id:
 * what a message sent over them declines.
 */
export const pendingLocalRunApprovalIds = (
  messages: readonly { readonly metadata?: unknown }[],
): readonly string[] =>
  chatLocalRunRequestsOf(messages.at(-1)?.metadata).flatMap((request) =>
    request.status === "pending" && request.ask.kind === "approval"
      ? [request.requestId]
      : [],
  );

/**
 * The step a run waits on the member's approval for, as its card asks it:
 * an approval under the request's id, which the answer names. The turn keeps
 * running meanwhile; the card is what waits. Only a request that can still
 * be answered (pending, in a turn that runs) is asked.
 */
export const awaitedLocalRunApproval = (
  part: ToolCallPart,
  request: ChatLocalRunRequest | null,
  turnRuns: boolean,
): ToolCallPart | null =>
  request !== null &&
  turnRuns &&
  request.status === "pending" &&
  request.ask.kind === "approval"
    ? {
        ...part,
        state: "approval-requested",
        approval: { id: request.requestId, needsApproval: true },
      }
    : null;

/**
 * Why a request closed without the member's answer reaching its run, as the
 * card says it, neutrally: the run's output stands as it is. A pending
 * request in a turn that no longer runs reads as the turn's stop. `null` for
 * a request answered, or still waiting in a running turn.
 */
export const unansweredLocalRunRequest = (
  request: ChatLocalRunRequest | null,
  turnRuns: boolean,
):
  | "runFinished"
  | "runFailed"
  | "withdrawn"
  | "runLost"
  | "cancelled"
  | null => {
  if (request === null) {
    return null;
  }
  switch (request.status) {
    case "resolved":
      return null;
    case "pending":
      return turnRuns ? null : "cancelled";
    case "cancelled":
      return "cancelled";
    case "expired":
      switch (request.expiry) {
        case "run_finished":
          return "runFinished";
        case "run_failed":
          return "runFailed";
        case "withdrawn":
          return "withdrawn";
        case "run_lost":
          return "runLost";
        default:
          request.expiry satisfies never;
          return panic("Unknown local run request expiry");
      }
    default:
      request satisfies never;
      return panic("Unknown local run request status");
  }
};
