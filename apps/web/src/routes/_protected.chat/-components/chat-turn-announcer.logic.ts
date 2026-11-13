import { panic } from "better-result";

import {
  getAwaitedAssistantMessageId,
  getCurrentApprovalPendingMessageId,
  type PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import type { TranslationKey } from "@/i18n/types";

/**
 * A change of the running turn's phase that a screen reader is told about:
 * the turn needs the member, or it ended. Progress while it runs is not
 * announced; the transcript itself says what the answer writes.
 */
type TurnAnnouncement =
  "needs-approval" | "has-question" | "stopped" | "failed" | "done";

export const TURN_ANNOUNCEMENT_KEYS = {
  "needs-approval": "chat.turnStatus.waitingForApproval",
  "has-question": "chat.turnStatus.waitingForInput",
  stopped: "chat.stopped",
  failed: "chat.turnStatus.answerFailed",
  done: "chat.turnStatus.answerReady",
} as const satisfies Record<TurnAnnouncement, TranslationKey>;

type Outcome = NonNullable<
  NonNullable<PersistedChatMessage["metadata"]>["turnOutcome"]
>;

/** What a finished turn's server-owned outcome says, if anything. */
const outcomeAnnouncement = (outcome: Outcome): TurnAnnouncement | null => {
  switch (outcome.type) {
    case "awaiting-user":
      switch (outcome.interaction.type) {
        case "approval":
          return "needs-approval";
        case "ask-user":
        case "harness-question":
          return "has-question";
        // The page answers a client tool itself; the member is not asked.
        case "client-tool":
          return null;
        default:
          return panic("Unhandled awaited interaction", {
            interaction: outcome.interaction satisfies never,
          });
      }
    case "completed":
      return "done";
    case "cancelled":
      // A superseded turn gave way to the member's next message.
      return outcome.reason === "user-stop" ? "stopped" : null;
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return panic("Unhandled turn outcome", {
        outcome: outcome satisfies never,
      });
  }
};

export type TurnAnnouncementInput = {
  messages: readonly PersistedChatMessage[];
  isGenerating: boolean;
  /** The chat client failed the turn before the server said how it ended. */
  hasError: boolean;
};

/** The calls of `messageId` still waiting on the member, as one id. */
const waitingCalls = (
  messages: readonly PersistedChatMessage[],
  messageId: string,
) => {
  const message = messages.findLast(({ id }) => id === messageId);
  if (message === undefined) {
    return panic("The awaited message is not in the thread", { messageId });
  }
  return message.parts
    .flatMap((part) =>
      part.type === "tool-call" &&
      (part.state === "approval-requested" || part.state === "input-complete")
        ? [part.id]
        : [],
    )
    .join(" ");
};

/**
 * The newest turn's phase worth announcing, with what it is about: the calls
 * waiting on the member, or the answer that ended. A new subject is a change
 * even when the phase is the same (the next turn's end, a second approval in
 * one answer). `null` while the turn runs or when nothing needs saying.
 */
export const turnAnnouncement = ({
  messages,
  isGenerating,
  hasError,
}: TurnAnnouncementInput): {
  subject: string;
  announcement: TurnAnnouncement;
} | null => {
  const approval = getCurrentApprovalPendingMessageId(messages);
  if (approval !== null) {
    return {
      subject: waitingCalls(messages, approval),
      announcement: "needs-approval",
    };
  }
  const awaited = getAwaitedAssistantMessageId(messages);
  if (awaited !== null) {
    return {
      subject: waitingCalls(messages, awaited),
      announcement: "has-question",
    };
  }
  if (isGenerating) {
    return null;
  }
  const last = messages.at(-1);
  if (last === undefined) {
    return null;
  }
  if (hasError) {
    return { subject: last.id, announcement: "failed" };
  }
  const outcome = last.role === "assistant" ? last.metadata?.turnOutcome : null;
  const announcement =
    outcome === null || outcome === undefined
      ? null
      : outcomeAnnouncement(outcome);
  return announcement === null ? null : { subject: last.id, announcement };
};
