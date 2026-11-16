import { TaggedError } from "better-result";

import { isThirdPartyBoundaryRefusalError } from "@stll/anonymize-chat";
import { AI_FAILURE_CODES } from "@stll/api-contract";

import type { TranslationKey } from "@/i18n/types";
import {
  AI_FAILURE_ERROR_KEYS,
  aiErrorKindFromMessage,
} from "@/lib/errors/ai-failure";
import type { AIFailureTranslationKey } from "@/lib/errors/ai-failure";

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

type ChatErrorTranslationKey =
  | AIFailureTranslationKey
  | "chat.sendErrorAnonymizationBlocked"
  | "chat.sendError"
  | (typeof CHAT_REQUEST_ERROR_TRANSLATION_KEYS)[ChatRequestError["kind"]];

/** What the chat tells the member about a failed chat request: in the
 *  thread, or in the notice beside the composer a refused message went back
 *  to. */
export const chatErrorTranslationKey = (
  error: Error,
): ChatErrorTranslationKey => {
  const requestError = findChatRequestError(error);
  if (requestError !== undefined) {
    return CHAT_REQUEST_ERROR_TRANSLATION_KEYS[requestError.kind];
  }
  if (isThirdPartyBoundaryRefusalError(error)) {
    return "chat.sendErrorAnonymizationBlocked";
  }
  // An unknown kind keeps the chat's own copy, which points to support.
  const kind = aiErrorKindFromMessage(error.message);
  if (kind !== undefined && kind !== "unknown") {
    return AI_FAILURE_ERROR_KEYS[AI_FAILURE_CODES[kind]];
  }
  return "chat.sendError";
};
