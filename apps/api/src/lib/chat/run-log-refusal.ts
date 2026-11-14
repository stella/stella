import { TaggedError } from "better-result";

import type { AIErrorKind } from "@stll/api-contract";
import { declareFingerprintFields } from "@stll/errors";

/**
 * Why a chat run log refused a batch. Every reason is decided before the batch
 * writes anything, so a refused batch is known not to be stored: it never holds
 * the log for a retry, and the next batch (a terminal error, say) still
 * appends.
 */
export const CHAT_RUN_LOG_REFUSAL_REASONS = [
  "chunk-too-large",
  "run-too-large",
  "fence-lost",
  "closed",
] as const;

export type ChatRunLogRefusalReason =
  (typeof CHAT_RUN_LOG_REFUSAL_REASONS)[number];

export const CHAT_RUN_LOG_REFUSALS = {
  "chunk-too-large": "Chat run log chunk exceeds its size limit",
  "run-too-large": "Chat run log exceeds its size limit",
  "fence-lost": "Chat run log execution fence lost",
  closed: "Chat run log is closed or bound to another turn",
} as const satisfies Record<ChatRunLogRefusalReason, string>;

/** The log refused a batch it is known not to have stored. */
export class ChatRunLogRefusedError extends TaggedError(
  "ChatRunLogRefusedError",
)<{ message: string; reason: ChatRunLogRefusalReason }> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

/**
 * What each refusal tells the member whose turn it ended, as the AI error kind
 * the chat reports. A size refusal is the turn's own output outgrowing one
 * delivered run, which a new message recovers from. A lost fence or a closed
 * log means another owner settles the turn, so there is nothing to explain.
 * Total over the reasons, so a new one is a decision here.
 */
export const CHAT_RUN_LOG_REFUSAL_KIND = {
  "chunk-too-large": "turn_too_large",
  "run-too-large": "turn_too_large",
  "fence-lost": "unknown",
  closed: "unknown",
} as const satisfies Record<ChatRunLogRefusalReason, AIErrorKind>;
