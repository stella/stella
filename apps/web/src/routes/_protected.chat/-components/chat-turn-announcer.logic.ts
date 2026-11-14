import { panic } from "better-result";

import {
  getAwaitedAssistantMessageId,
  getCurrentApprovalPendingMessageId,
  isApprovalRequestPart,
  isUserAnswerablePart,
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

type Announced = { subject: string; announcement: TurnAnnouncement };

/** A phase and what it is about, as one key: the announced node's identity. */
export const announcementKey = ({ announcement, subject }: Announced) =>
  `${announcement}:${subject}`;

/**
 * What the thread shows of its turn (`announcementKey`, `null` for nothing)
 * and how many turns the page has started on it by then (`turnsStarted` of
 * the chat runtime).
 */
type ShownPhase = { key: string | null; turnsStarted: number };

type OpeningPhaseOptions = {
  /** What the thread showed when it opened. */
  opening: ShownPhase;
  shown: ShownPhase;
};

/**
 * Whether the thread shows what it already showed when it opened, which is
 * not announced. Once the page starts a turn, the same phase about the same
 * message is news: a retry that leaves the thread on the answer it opened
 * on, whether it wrote that answer again or never replaced it.
 */
export const isOpeningPhase = ({ opening, shown }: OpeningPhaseOptions) =>
  shown.key === opening.key && shown.turnsStarted === opening.turnsStarted;

/**
 * What the server-owned outcome of answer `answerId` says, if anything. A
 * waiting outcome is about the call it waits on, an ended one about the
 * answer.
 */
const outcomeAnnouncement = (
  answerId: string,
  outcome: Outcome,
): Announced | null => {
  switch (outcome.type) {
    case "awaiting-user":
      switch (outcome.interaction.type) {
        case "approval":
          return {
            subject: outcome.interaction.toolCallId,
            announcement: "needs-approval",
          };
        case "ask-user":
        case "harness-question":
          return {
            subject: outcome.interaction.toolCallId,
            announcement: "has-question",
          };
        // The page answers a client tool itself; the member is not asked.
        case "client-tool":
          return null;
        default:
          return panic("Unhandled awaited interaction", {
            interaction: outcome.interaction satisfies never,
          });
      }
    case "completed":
      return { subject: answerId, announcement: "done" };
    case "cancelled":
      // A superseded turn gave way to the member's next message.
      return outcome.reason === "user-stop"
        ? { subject: answerId, announcement: "stopped" }
        : null;
    case "failed":
    case "interrupted":
      return { subject: answerId, announcement: "failed" };
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

/**
 * The calls of `messageId` that `isWaiting` accepts, as one id. Only calls
 * waiting on the member count: a tool that runs beside them changes nothing
 * the member was told.
 */
const waitingCalls = (
  messages: readonly PersistedChatMessage[],
  messageId: string,
  isWaiting: (part: PersistedChatMessage["parts"][number]) => boolean,
) => {
  const message = messages.findLast(({ id }) => id === messageId);
  if (message === undefined) {
    return panic("The awaited message is not in the thread", { messageId });
  }
  return message.parts
    .flatMap((part) =>
      part.type === "tool-call" && isWaiting(part) ? [part.id] : [],
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
}: TurnAnnouncementInput): Announced | null => {
  const approval = getCurrentApprovalPendingMessageId(messages);
  if (approval !== null) {
    return {
      subject: waitingCalls(messages, approval, isApprovalRequestPart),
      announcement: "needs-approval",
    };
  }
  const awaited = getAwaitedAssistantMessageId(messages);
  if (awaited !== null) {
    return {
      subject: waitingCalls(messages, awaited, isUserAnswerablePart),
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
  return outcome === null || outcome === undefined
    ? null
    : outcomeAnnouncement(last.id, outcome);
};
