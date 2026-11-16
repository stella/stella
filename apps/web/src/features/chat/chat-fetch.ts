import { Result } from "better-result";

import { SSE_SILENCE_BOUND_MS } from "@stll/api-contract/sse-heartbeat";
import { fetchWithTimeout } from "@stll/fetch";
import {
  iterateBodyWithIdleDeadline,
  readBodyJsonWithIdleDeadline,
} from "@stll/fetch/body-reader";

import { ChatRequestError } from "@/features/chat/chat-request-error";
import { toAPIError } from "@/lib/errors/api";
import type { APIError } from "@/lib/errors/api";

// How long the server may take to answer a chat request with its headers.
// Only the headers have a deadline. The stream that follows is bounded by its
// liveness (`SSE_SILENCE_BOUND_MS`), never by how long it has run: how long a
// turn may take is the server's to enforce, and a turn on the member's
// computer runs for as long as that computer answers.
const CHAT_HEADERS_TIMEOUT_MS = 600_000;

// How long a refusal's body may stall between chunks. Its status is already
// known, so a body that never completes costs the envelope, not the refusal.
const CHAT_REFUSAL_BODY_IDLE_MS = 10_000;

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
    async () =>
      await readBodyJsonWithIdleDeadline(response, {
        idleMs: CHAT_REFUSAL_BODY_IDLE_MS,
      }),
  );
  return toAPIError({
    status: response.status,
    // A refusal from a proxy ahead of the API carries no JSON envelope, and
    // one whose body stalls is read as far as its status.
    value: Result.isOk(body) ? body.value : response.statusText,
  });
};

type StreamOfChunksOptions = {
  /** The transport body `chunks` reads. */
  body: ReadableStream<Uint8Array>;
  /** Aborted when the stream is cancelled; it ends a read in flight. */
  cancelled: AbortController;
  chunks: AsyncGenerator<Uint8Array, void, void>;
};

/** A byte stream over `chunks` that releases the transport when cancelled. */
const streamOfChunks = ({ body, cancelled, chunks }: StreamOfChunksOptions) =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason: unknown) {
      // A read in flight holds the iterator, so `return()` alone would wait
      // for the next chunk: the abort ends that read, and the iterator then
      // releases the transport on its way out.
      cancelled.abort(reason);
      await chunks.return();
      if (!body.locked) {
        // The iterator never started, so nothing else holds the transport.
        await body.cancel(reason);
      }
    },
  });

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
            timeout: { type: "headers", ms: CHAT_HEADERS_TIMEOUT_MS },
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
    if (response.body === null) {
      return response;
    }
    // A stream that stays silent past the bound fails its read, which the
    // transport rejoins exactly as it does a dropped connection. The body is
    // rebuilt because the parser that reads it is the SDK's: only a read made
    // here can be held to the bound.
    const cancelled = new AbortController();
    return new Response(
      streamOfChunks({
        body: response.body,
        cancelled,
        chunks: iterateBodyWithIdleDeadline(response, {
          idleMs: SSE_SILENCE_BOUND_MS,
          signal:
            effectiveSignal === undefined
              ? cancelled.signal
              : AbortSignal.any([effectiveSignal, cancelled.signal]),
        }),
      }),
      {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      },
    );
  },
  // Bun augments the global fetch type with this optional optimization.
  // TanStack accepts `typeof globalThis.fetch`; the browser transport does
  // not need preconnection, so expose a typed no-op instead of casting.
  { preconnect: () => undefined },
) satisfies typeof globalThis.fetch;
