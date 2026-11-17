import type { SafeId } from "@/api/lib/branded-types";
import {
  announceChatTurnHandover,
  registerChatTurnHandoverDelivery,
} from "@/api/lib/sse";

/** A chat turn a stopping task released, as adopters are told of it. */
export type ReleasedChatTurn = {
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
  userId: SafeId<"user">;
};

type ChatTurnAdopterAnswer = (turn: ReleasedChatTurn) => void;

let answer: ChatTurnAdopterAnswer | null = null;

/**
 * Tell adopters a turn was released, once its release committed: this
 * process's adopter at once, and every other API task over the realtime
 * channel. The ring is a hint, never the only way a turn is adopted: it is
 * lost when nothing answers (a stopping task, a test, a channel outage), and
 * the adoption sweep finds the turn then. Only ids travel; the adopter's
 * claim reads the rest under the thread lock.
 */
export const ringChatTurnAdopters = (turn: ReleasedChatTurn): void => {
  answer?.(turn);
  announceChatTurnHandover(turn);
};

/**
 * Adopt released turns with `adopt`, rung here or on another task, until the
 * returned stop runs; the server calls this once at boot.
 */
export const answerChatTurnAdopterDoorbell = (
  adopt: ChatTurnAdopterAnswer,
): (() => void) => {
  answer = adopt;
  registerChatTurnHandoverDelivery(adopt);
  return () => {
    if (answer === adopt) {
      answer = null;
      registerChatTurnHandoverDelivery(null);
    }
  };
};
