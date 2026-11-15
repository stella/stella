import { panic, Result } from "better-result";

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
 * What the member is asked, in the harness's words: the kind of step, the
 * key or option, the element's role and accessible name, and the page's
 * address. Never text read from the page beyond the element's name. Chat
 * shows the question in the member's language from the call's `asked`.
 */
const approvalReason = (asked: BrowserApprovalRequest): string => {
  const element = `the ${asked.role} "${asked.name}" on ${asked.url}`;
  const reason = (() => {
    switch (asked.action) {
      case "click":
        return `Click ${element}`;
      case "type":
        return `Type into ${element}`;
      case "press_key":
        return `Press ${asked.key} in ${element}`;
      case "select":
        return `Choose "${asked.option}" in ${element}`;
      default:
        asked satisfies never;
        return panic("Unhandled browser approval");
    }
  })();
  return chatLocalRunShownText(reason, CHAT_LOCAL_RUN_TOOL_LIMITS.approval);
};

/** The approval's call, as chat keeps it: the step and what it is about. */
const approvalCall = (asked: BrowserApprovalRequest) => {
  const about = { name: asked.name, role: asked.role, url: asked.url };
  switch (asked.action) {
    case "click":
    case "type":
      return { action: asked.action, asked: about };
    case "press_key":
      return { action: asked.action, asked: { ...about, key: asked.key } };
    case "select":
      return {
        action: asked.action,
        asked: { ...about, option: asked.option },
      };
    default:
      asked satisfies never;
      return panic("Unhandled browser approval");
  }
};

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
      input: approvalCall(asked),
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
    // The question's end goes into the stream as it is settled, not when
    // this call resumes: a stream that is ending still carries it.
    const settle = (decision: ApprovalDecision) => {
      asked.signal.removeEventListener("abort", withdraw);
      side.push({ type: "interaction.resolved", requestId });
      if (decision === APPROVAL_DECISION.deny) {
        complete(asked.signal.aborted ? "interrupted" : "declined");
      }
      resolve(decision);
    };
    // The agent's call ended (a harness timeout, a stop): the question is
    // withdrawn, never answered later for an action that cannot run.
    const withdraw = () => {
      if (pending.delete(requestId)) {
        settle(APPROVAL_DECISION.deny);
      }
    };
    pending.set(requestId, settle);
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
    if (asked.signal.aborted) {
      withdraw();
    } else {
      asked.signal.addEventListener("abort", withdraw, { once: true });
    }
    if ((await promise) === APPROVAL_DECISION.deny) {
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
    for (const [requestId, settle] of pending) {
      pending.delete(requestId);
      settle(APPROVAL_DECISION.deny);
    }
  };

  return {
    request,
    /**
     * Answers the question `requestId` (the id it was asked under); false
     * when it is not one of these, so the harness's own approvals go on.
     */
    answer: (requestId: string, decision: ApprovalDecision): boolean => {
      const settle = pending.get(requestId);
      if (settle === undefined) {
        return false;
      }
      pending.delete(requestId);
      settle(decision);
      return true;
    },
    declineAll,
    /**
     * The harness's events with these questions' events beside them, in
     * the order they happen; ends with the harness's, after whatever is
     * still open was declined and reported. The harness's events are moved
     * into the questions' queue, so a turn of any length holds one reader.
     */
    async *withEvents(
      harness: AsyncIterable<HarnessEvent>,
    ): AsyncGenerator<HarnessEvent> {
      const moved = (async () => {
        for await (const event of harness) {
          side.push(event);
        }
      })();
      const ended = async () => {
        // Observed here so a failure is never unhandled while the queue
        // drains.
        const outcome = await Result.tryPromise({
          try: async () => {
            await moved;
          },
          catch: (cause) => ({ cause }),
        });
        declineAll();
        side.close();
        return outcome;
      };
      const closed = ended();
      try {
        yield* side.items;
        const harnessEnd = await closed;
        if (Result.isError(harnessEnd)) {
          // Awaiting the rejected promise ends the stream with its failure.
          await moved;
        }
      } finally {
        declineAll();
        side.close();
      }
    },
  };
};

export type ActionApprovals = ReturnType<typeof createActionApprovals>;
