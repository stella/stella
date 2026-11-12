import {
  CHAT_LOCAL_RUN_TOOL_LIMITS,
  chatLocalRunShownText,
  chatLocalRunToolResultContent,
  type ChatLocalRunToolStatus,
} from "@stll/api-contract/chat-local-run-tool";
import type { DESKTOP_RUNNER_APPROVAL_DECISIONS } from "@stll/api-contract/desktop-runner";

import { createEventQueue } from "../../harness/event-queue";
import type { HarnessEvent } from "../../harness/events";
import { HARNESS_TOOL_NAMES, nativeToolCall } from "../../harness/tool-parts";
import {
  APPROVAL_DECISION,
  type ApprovalTicket,
  type ApproveAction,
  type BrowserApprovalRequest,
} from "./tools";

type ApprovalDecision = (typeof DESKTOP_RUNNER_APPROVAL_DECISIONS)[number];

/**
 * What the member is asked: the kind of step, the element's role and
 * accessible name, and the page's address. Never text read from the page
 * beyond the element's name.
 */
const approvalReason = ({ action, name, role, url }: BrowserApprovalRequest) =>
  chatLocalRunShownText(
    `${action === "click" ? "Click" : "Type into"} the ${role} "${name}" on ${url}`,
    CHAT_LOCAL_RUN_TOOL_LIMITS.approval,
  );

/**
 * A run's approvals for browser steps. The browser tools ask while the
 * agent's call waits; each question reaches chat as the harness's own
 * approvals do (an approval on a `local_browser` step, the desktop's
 * `run.approval_request`), and the member's answer comes back through
 * `run.approval`. The step's outcome is reported once the action ran, so
 * chat never shows a step done that did not happen. The events go into the
 * run's stream beside the harness's, through `withEvents`.
 */
export const createActionApprovals = () => {
  const side = createEventQueue<HarnessEvent>();
  const pending = new Map<string, (decision: ApprovalDecision) => void>();

  const request: ApproveAction = async (asked) => {
    const requestId = `browser-step-${crypto.randomUUID()}`;
    const toolCall = nativeToolCall(requestId, {
      name: HARNESS_TOOL_NAMES.browser,
      input: { action: asked.action },
    });
    const complete = (status: ChatLocalRunToolStatus) => {
      side.push({
        type: "tool.completed",
        toolCall,
        result: {
          content: chatLocalRunToolResultContent({
            name: HARNESS_TOOL_NAMES.browser,
            result: { status },
          }),
          status: status === "completed" ? "succeeded" : "failed",
        },
      });
    };
    const { promise, resolve } = Promise.withResolvers<ApprovalDecision>();
    pending.set(requestId, resolve);
    // The agent's call ended (a harness timeout, a stop): the question is
    // withdrawn, never answered later for an action that cannot run.
    const withdraw = () => {
      if (pending.delete(requestId)) {
        resolve(APPROVAL_DECISION.deny);
      }
    };
    if (asked.signal.aborted) {
      withdraw();
    } else {
      asked.signal.addEventListener("abort", withdraw, { once: true });
    }
    side.push({
      type: "approval.requested",
      request: {
        requestId,
        kind: "tool",
        toolCall,
        reason: approvalReason(asked),
        options: [
          {
            id: APPROVAL_DECISION.approve,
            decision: APPROVAL_DECISION.approve,
          },
          { id: APPROVAL_DECISION.deny, decision: APPROVAL_DECISION.deny },
        ],
      },
    });
    const decision = await promise;
    asked.signal.removeEventListener("abort", withdraw);
    side.push({ type: "interaction.resolved", requestId });
    if (decision === APPROVAL_DECISION.deny) {
      complete(asked.signal.aborted ? "interrupted" : "declined");
      return { decision: APPROVAL_DECISION.deny, finish: () => undefined };
    }
    let finished = false;
    return {
      decision: APPROVAL_DECISION.approve,
      finish: (status) => {
        if (!finished) {
          finished = true;
          complete(status);
        }
      },
    } satisfies ApprovalTicket;
  };

  /** Settles every open question as declined: the run is ending. */
  const declineAll = () => {
    for (const [requestId, resolve] of pending) {
      pending.delete(requestId);
      resolve(APPROVAL_DECISION.deny);
    }
  };

  return {
    request,
    /**
     * Answers the question `requestId` (the id it was asked under); false
     * when it is not one of these, so the harness's own approvals go on.
     */
    answer: (requestId: string, decision: ApprovalDecision): boolean => {
      const resolve = pending.get(requestId);
      if (resolve === undefined) {
        return false;
      }
      pending.delete(requestId);
      resolve(decision);
      return true;
    },
    declineAll,
    /**
     * The harness's events with these questions' events beside them, in
     * the order they happen; ends with the harness's, declining whatever is
     * still open.
     */
    async *withEvents(
      harness: AsyncIterable<HarnessEvent>,
    ): AsyncGenerator<HarnessEvent> {
      const primary = harness[Symbol.asyncIterator]();
      const secondary = side.items[Symbol.asyncIterator]();
      let nextPrimary = primary.next();
      let nextSecondary = secondary.next();
      try {
        for (;;) {
          // await-in-loop: one event at a time, from whichever source has one.
          const first = await Promise.race([
            nextPrimary.then((step) => ({ from: "harness", step }) as const),
            nextSecondary.then(
              (step) => ({ from: "approvals", step }) as const,
            ),
          ]);
          if (first.from === "harness") {
            if (first.step.done === true) {
              return;
            }
            yield first.step.value;
            nextPrimary = primary.next();
          } else if (first.step.done !== true) {
            yield first.step.value;
            nextSecondary = secondary.next();
          } else {
            // The questions end only with the run: wait on the harness.
            nextSecondary =
              Promise.withResolvers<IteratorResult<HarnessEvent>>().promise;
          }
        }
      } finally {
        declineAll();
        side.close();
      }
    },
  };
};

export type ActionApprovals = ReturnType<typeof createActionApprovals>;
