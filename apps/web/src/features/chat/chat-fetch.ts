import { Result } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import { ChatRequestError } from "@/features/chat/chat-request-error";
import { toAPIError } from "@/lib/errors/api";
import type { APIError } from "@/lib/errors/api";

// Matches the backend's own AI-call budget (send-message.ts'
// CHAT_METERED_AI_TIMEOUT_MS) so the client doesn't cut a slow-but-healthy
// model response off before the server would.
const CHAT_FETCH_TIMEOUT_MS = 600_000;

/**
 * The typed error for a chat response the API refused.
 *
 * The connection adapter answers every non-2xx with the same
 * `HTTP error! status: <n>` string and discards the body, so each of the
 * dozens of checks that can reject a chat request arrives at the toast and at
 * `$exception` indistinguishable from the rest. Reading the body here, while
 * the response is still whole, keeps the API's status and error code on an
 * `APIError` that `captureError` already lifts onto the reported event.
 *
 * Only a refused response is read; a 2xx stream is handed on untouched.
 * The rejoin probe reads its refusals the same way, so a session that ended
 * mid-answer still reaches the page as the server's 401.
 */
export const chatResponseError = async (
  response: Response,
): Promise<APIError> => {
  const body = await Result.tryPromise(
    async (): Promise<unknown> => await response.json(),
  );
  return toAPIError({
    status: response.status,
    // A refusal from a proxy ahead of the API carries no JSON envelope.
    value: Result.isOk(body) ? body.value : response.statusText,
  });
};

export const chatFetchClient = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const { signal, ...requestInit } = init ?? {};
    const effectiveSignal =
      signal ?? (input instanceof Request ? input.signal : undefined);
    const received = await Result.tryPromise({
      try: async () =>
        // The timeout helper combines Request and init signals. Normalize an
        // overriding signal first to preserve fetch's replacement semantics.
        await fetchWithTimeout(
          input instanceof Request && signal !== undefined && signal !== null
            ? new Request(input, { signal })
            : input,
          {
            ...requestInit,
            ...(signal === null ? {} : { signal }),
            timeoutMs: CHAT_FETCH_TIMEOUT_MS,
          },
        ),
      catch: (cause) => {
        if (effectiveSignal?.aborted) {
          return cause;
        }
        const timedOut =
          cause instanceof DOMException && cause.name === "TimeoutError";
        return new ChatRequestError({
          kind: timedOut ? "timed_out" : "connection_failed",
          message: timedOut
            ? "Chat request timed out"
            : "Chat connection failed",
          cause,
        });
      },
    });
    if (received.isErr()) {
      throw received.error;
    }
    const response = received.value;
    if (!response.ok) {
      throw await chatResponseError(response);
    }
    return response;
  },
  // Bun augments the global fetch type with this optional optimization.
  // TanStack accepts `typeof globalThis.fetch`; the browser transport does
  // not need preconnection, so expose a typed no-op instead of casting.
  { preconnect: () => undefined },
) satisfies typeof globalThis.fetch;
