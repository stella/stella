import {
  type ChatLocalRunRequest,
  chatLocalRunRequestsOf,
} from "@stll/api-contract/chat-local-run-request";

import { isApprovalPart } from "@/components/chat/chat-ui-tools";
import type { ApprovalToolPart } from "@/components/chat/chat-ui-tools-types";

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
  part: { readonly id: string },
  request: ChatLocalRunRequest | null,
  turnRuns: boolean,
): ApprovalToolPart | null => {
  if (
    request === null ||
    !turnRuns ||
    request.status !== "pending" ||
    request.ask.kind !== "approval"
  ) {
    return null;
  }
  const asked = {
    ...part,
    state: "approval-requested",
    approval: { id: request.requestId, needsApproval: true },
  };
  return isApprovalPart(asked) ? asked : null;
};

/** How a step's card draws the approval its run asked about it. */
type LocalRunApprovalDrawing = {
  state: "approval-requested" | "approval-responded" | null;
  approval: { id: string; needsApproval: true; approved?: boolean };
};

/**
 * The approval a step's card draws for what its run asked about it: asking
 * while the request waits in an answer still streaming (a settled answer
 * names its `turnOutcome`, and its run asks nothing any more), and the
 * member's decision once the run took it. `state` is the call's new state,
 * or `null` to keep its own (a result already came). `null` for a call no
 * approval names, or one the run went on without.
 */
export const localRunApprovalDrawing = (
  part: { readonly id: string; readonly state: string },
  metadata: unknown,
): LocalRunApprovalDrawing | null => {
  const request = localRunRequestOfCall(metadata, part.id);
  if (request?.ask.kind !== "approval") {
    return null;
  }
  const settled =
    typeof metadata === "object" &&
    metadata !== null &&
    Reflect.get(metadata, "turnOutcome") !== undefined;
  if (request.status === "pending") {
    return settled
      ? null
      : {
          state: "approval-requested",
          approval: { id: request.requestId, needsApproval: true },
        };
  }
  if (request.status !== "resolved" || request.decision === undefined) {
    return null;
  }
  return {
    state: part.state === "input-complete" ? "approval-responded" : null,
    approval: {
      id: request.requestId,
      needsApproval: true,
      approved: request.decision !== "deny",
    },
  };
};
