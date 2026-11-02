import { TaggedError } from "better-result";

import type { TranslationKey } from "@/i18n/types";

export class ChatRequestError extends TaggedError("ChatRequestError")<{
  kind:
    "preparation_failed" | "connection_failed" | "timed_out" | "not_started";
  message: string;
  cause?: unknown;
}> {}

/** What the page tells the user for each way a chat request failed. */
export const CHAT_REQUEST_ERROR_TRANSLATION_KEYS = {
  preparation_failed: "chat.sendErrorPreparationFailed",
  connection_failed: "chat.sendErrorConnectionFailed",
  timed_out: "chat.sendErrorTimedOut",
  not_started: "chat.sendErrorNotStarted",
} as const satisfies Record<ChatRequestError["kind"], TranslationKey>;

/** SDK transport wrappers retain the typed cause; replay may lose it. */
export const findChatRequestError = (
  error: unknown,
): ChatRequestError | undefined => {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (ChatRequestError.is(current)) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
};

/** Body-read errors acquire an SDK wrapper after response headers arrive. */
export const normalizeChatStreamError = (error: Error): Error => {
  const seen = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (ChatRequestError.is(current)) {
      return error;
    }
    if (current instanceof DOMException && current.name === "TimeoutError") {
      return new ChatRequestError({
        kind: "timed_out",
        message: "Chat stream timed out",
        cause: current,
      });
    }
    seen.add(current);
    current = current.cause;
  }
  return error;
};
