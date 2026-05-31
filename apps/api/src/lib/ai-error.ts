/**
 * Stable, user-facing classification of AI provider errors.
 *
 * The `AIErrorKind` strings cross the network as the chat
 * stream's error message; the frontend maps them to i18n keys.
 * Renaming a kind is a wire-format change — update both sides
 * (and `chat-thread-messages.tsx`) together.
 */
import { APICallError, RetryError } from "ai";

import {
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";

export const AI_ERROR_KINDS = [
  "quota_exhausted",
  "insufficient_credits",
  "provider_unavailable",
  "loop_detected",
  "unknown",
] as const;

export type AIErrorKind = (typeof AI_ERROR_KINDS)[number];

export const classifyAIError = (error: unknown): AIErrorKind => {
  if (RetryError.isInstance(error)) {
    return classifyAIError(error.lastError);
  }
  if (ChatLoopDetectedError.is(error)) {
    return "loop_detected";
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) {
      return "quota_exhausted";
    }
    if (error.statusCode === 402) {
      return "insufficient_credits";
    }
    if (error.statusCode !== undefined && error.statusCode >= 500) {
      return "provider_unavailable";
    }
  }
  // Walk through any wrapper that carries the original provider error
  // on `cause` (e.g. our own `WorkflowIntegrationError`, or generic
  // `Error.cause` from a higher-level rethrow). Without this, callers
  // that pass a wrapped error get classified as `unknown` and miss the
  // mapped HTTP status / UX copy.
  if (
    error !== null &&
    typeof error === "object" &&
    "cause" in error &&
    error.cause !== undefined
  ) {
    return classifyAIError(error.cause);
  }
  return "unknown";
};

type AIHandlerErrorFallback = {
  status: HandlerErrorStatusCode;
  message: string;
};

/**
 * Build a `HandlerError` for an AI provider failure.
 *
 * For known AI failure modes (quota, credits, transient
 * upstream outage) returns a typed error with an actionable
 * status + message. For everything else, returns the caller's
 * fallback so unrelated bugs aren't masked as "AI unavailable".
 */
export const aiHandlerError = (
  error: unknown,
  fallback: AIHandlerErrorFallback,
): HandlerError => {
  const kind = classifyAIError(error);
  switch (kind) {
    case "quota_exhausted":
      return new HandlerError({
        status: 429,
        message:
          "The AI provider's quota is exhausted. Try again shortly, or contact your workspace admin to upgrade the plan.",
        cause: error,
      });
    case "insufficient_credits":
      return new HandlerError({
        status: 402,
        message:
          "The AI provider needs more credits. Contact your workspace admin to top up the account.",
        cause: error,
      });
    case "provider_unavailable":
      return new HandlerError({
        status: 502,
        message:
          "The AI provider is temporarily unavailable. Please try again in a moment.",
        cause: error,
      });
    case "loop_detected":
      return new HandlerError({
        status: 502,
        message:
          "The AI model repeated the same work and could not recover. Please try again with a narrower request.",
        cause: error,
      });
    case "unknown":
      return new HandlerError({ ...fallback, cause: error });
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
};

type AIErrorStatusBody = {
  status: HandlerErrorStatusCode;
  body: { message: string };
};

/**
 * Variant of `aiHandlerError` for handlers that build an Elysia
 * `status()` response directly instead of returning `HandlerError`.
 * Returns `{ status, body }` so callers can spread it into
 * `status(status, body)`.
 */
export const aiErrorStatusBody = (
  error: unknown,
  fallback: { status: HandlerErrorStatusCode; message: string },
): AIErrorStatusBody => {
  const handlerError = aiHandlerError(error, fallback);
  return {
    status: handlerError.status,
    body: { message: handlerError.message },
  };
};
