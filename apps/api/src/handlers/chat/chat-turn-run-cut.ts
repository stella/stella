import { RUN_CANCEL_REASON } from "@tanstack/ai";
import { panic } from "better-result";

import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";

/**
 * The abort reason of a run that no longer owns its turn: its lease was lost,
 * or its process is shutting down. It ends the turn as `owner-lost`.
 */
export const CHAT_TURN_OWNER_LOST_REASON = "stella.chat-turn.owner-lost";

/** The abort reason of a run whose durable pump failed; it ends the source. */
export const CHAT_TURN_PRODUCTION_FAILED_REASON =
  "stella.chat-turn.production-failed";

/**
 * What cut a turn's run short, by the reason its abort signal carries: the
 * member's stop (upstream's explicit-cancel reason), a lost owner, a failed
 * production, a lost execution admission, or anything else, which is the
 * provider deadline or a closed response.
 */
export const CHAT_TURN_RUN_CUTS = [
  "member-stop",
  "owner-lost",
  "production-failed",
  "admission-lost",
  "other",
] as const;
export type ChatTurnRunCut = (typeof CHAT_TURN_RUN_CUTS)[number];

/** The cut an aborted run's signal names by its `reason`. */
export const chatTurnRunCutOf = (reason: unknown): ChatTurnRunCut => {
  if (reason === RUN_CANCEL_REASON) {
    return "member-stop";
  }
  if (reason === CHAT_TURN_OWNER_LOST_REASON) {
    return "owner-lost";
  }
  if (reason === CHAT_TURN_PRODUCTION_FAILED_REASON) {
    return "production-failed";
  }
  if (ActionAdmissionError.is(reason)) {
    return "admission-lost";
  }
  return "other";
};

/**
 * Whether `signal` was cut by the member's stop or by a lost owner. Each ends
 * the turn its own way, so either outranks a lost admission that cut the
 * provider too.
 */
export const isCutByStopOrOwnerLoss = (signal: AbortSignal): boolean => {
  const cut = chatTurnRunCutOf(signal.reason);
  switch (cut) {
    case "member-stop":
    case "owner-lost":
      return true;
    case "production-failed":
    case "admission-lost":
    case "other":
      return false;
    default:
      cut satisfies never;
      return panic(`Unhandled chat turn run cut: ${String(cut)}`);
  }
};
