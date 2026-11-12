import { chatLocalRunToolResultContent } from "@stll/api-contract/chat-local-run-tool";
import type { DESKTOP_RUNNER_APPROVAL_DECISIONS } from "@stll/api-contract/desktop-runner";

import { createEventQueue } from "../../harness/event-queue";
import type { HarnessEvent } from "../../harness/events";
import { HARNESS_TOOL_NAMES, nativeToolCall } from "../../harness/tool-parts";
import { TYPING_DECISION, type TypingDecision } from "./tools";

type ApprovalDecision = (typeof DESKTOP_RUNNER_APPROVAL_DECISIONS)[number];

/** Why the member is asked; it names no field or text from the page. */
const TYPING_REASON =
  "Type into a field on this page that is not a search field.";

/**
 * A run's approvals for typing outside a search field. The browser tools
 * ask while the agent's call waits; each question reaches chat as the
 * harness's own approvals do (an approval on a `local_browser` step, the
 * desktop's `run.approval_request`), and the member's answer comes back
 * through `run.approval`. The events go into the run's stream beside the
 * harness's, through `withEvents`.
 */
export const createTypingApprovals = () => {
  const side = createEventQueue<HarnessEvent>();
  const pending = new Map<string, (decision: TypingDecision) => void>();

  const request = async ({ url }: { url: string }): Promise<TypingDecision> => {
    const requestId = `browser-type-${crypto.randomUUID()}`;
    const toolCall = nativeToolCall(requestId, {
      name: HARNESS_TOOL_NAMES.browser,
      input: { action: "type", url },
    });
    const { promise, resolve } = Promise.withResolvers<TypingDecision>();
    pending.set(requestId, resolve);
    side.push({
      type: "approval.requested",
      request: {
        requestId,
        kind: "tool",
        toolCall,
        reason: TYPING_REASON,
        options: [
          { id: TYPING_DECISION.approve, decision: TYPING_DECISION.approve },
          { id: TYPING_DECISION.deny, decision: TYPING_DECISION.deny },
        ],
      },
    });
    const decision = await promise;
    side.push({ type: "interaction.resolved", requestId });
    side.push({
      type: "tool.completed",
      toolCall,
      result: {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.browser,
          result: {
            status:
              decision === TYPING_DECISION.deny ? "declined" : "completed",
          },
        }),
        status: decision === TYPING_DECISION.deny ? "failed" : "succeeded",
      },
    });
    return decision;
  };

  /** Settles every open question as declined: the run is ending. */
  const declineAll = () => {
    for (const [requestId, resolve] of pending) {
      pending.delete(requestId);
      resolve(TYPING_DECISION.deny);
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
      resolve(
        decision === TYPING_DECISION.deny
          ? TYPING_DECISION.deny
          : TYPING_DECISION.approve,
      );
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

export type TypingApprovals = ReturnType<typeof createTypingApprovals>;
