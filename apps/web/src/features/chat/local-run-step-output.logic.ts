import { panic } from "better-result";

import { CHAT_LOCAL_RUN_STEP_CONTENT_STATE } from "@stll/api-contract/chat-local-run-step-content";
import type { LocalRunStepOutputView } from "@stll/api-contract/chat-local-run-step-content-view";

/**
 * How long a read step stays fresh: for good once it settled (a settled
 * step's content never changes), not at all while it may still change: its
 * content is arriving, a fork has yet to copy it, or a read was cut short.
 */
export const localRunStepOutputStaleTime = (
  view: LocalRunStepOutputView | undefined,
): number => {
  switch (view?.status) {
    case undefined:
    case "unread":
      return 0;
    case "text":
      return view.readBytes < view.storedBytes ? 0 : Number.POSITIVE_INFINITY;
    case "answered":
      return view.content.state ===
        CHAT_LOCAL_RUN_STEP_CONTENT_STATE.arriving ||
        view.content.state === CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notCopied
        ? 0
        : Number.POSITIVE_INFINITY;
    default:
      view satisfies never;
      return panic("Unhandled step output view");
  }
};
