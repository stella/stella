/**
 * Every `text/event-stream` response this service serves, and the timer that
 * keeps one writing while its producer is silent.
 *
 * An event stream that goes quiet is indistinguishable from a dead connection
 * to everything between this process and the browser. The CDN and the load
 * balancer in front of it both give up after 60 s without a byte, and a chat
 * turn whose model thinks through a tool result produces no events for longer
 * than that: the edge drops the connection mid-turn, the provider request is
 * aborted, and the answer is lost. The frames written here are comments the
 * event-stream grammar tells every reader to ignore, so they reset those idle
 * timers without adding an event.
 *
 * `sseResponse` builds a stream this service authors; `withSseHeartbeat` wraps
 * one a library produced. Both are the same writer, so an event stream cannot
 * be served without it.
 */

import { panic } from "better-result";

import { SSE_HEARTBEAT_FRAME } from "@stll/api-contract/sse-heartbeat";

import { LIMITS } from "@/api/lib/limits";

const HEARTBEAT_CHUNK = new TextEncoder().encode(SSE_HEARTBEAT_FRAME);

const SSE_MEDIA_TYPE = "text/event-stream";

/**
 * `no-store` and `no-transform` together: an intermediary must neither keep a
 * copy of a per-request stream nor buffer or recode it, and `x-accel-buffering`
 * says the same to a reverse proxy that reads it.
 */
const SSE_HEADERS = {
  "cache-control": "no-cache, no-store, no-transform",
  connection: "keep-alive",
  "content-type": SSE_MEDIA_TYPE,
  "x-accel-buffering": "no",
} as const;

/**
 * Whether a response another layer produced is an event stream, read off the
 * media type alone: the parameters after it (`; charset=utf-8`) are not part
 * of the answer.
 */
export const isEventStreamResponse = (response: Response): boolean =>
  response.headers
    .get("content-type")
    ?.split(";")
    .at(0)
    ?.trim()
    .toLowerCase() === SSE_MEDIA_TYPE;

type HeartbeatState = "closed" | "open";

/**
 * The reader's owner is the stream returned below: it holds the lock for the
 * whole response and gives it up by reading to EOF or by cancelling, both of
 * which end the source.
 */
const takeStreamReaderOwnership = <T>(body: ReadableStream<T>) =>
  body.getReader();

const withHeartbeatFrames = (
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> => {
  const reader = takeStreamReaderOwnership(source);
  let state: HeartbeatState = "open";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const close = (): void => {
    state = "closed";
    disarm();
  };
  // Armed from the last byte written, not on a fixed schedule: a stream that is
  // producing already keeps the connection busy and must not be padded.
  const arm = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    disarm();
    timer = setTimeout(() => {
      timer = undefined;
      if (state === "closed") {
        return;
      }
      controller.enqueue(HEARTBEAT_CHUNK);
      arm(controller);
    }, LIMITS.sseHeartbeatMs);
  };

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      arm(controller);
    },
    pull: async (controller) => {
      try {
        const result = await reader.read();
        // The consumer can cancel while this read is outstanding, and a
        // cancelled stream rejects both `close` and `enqueue`.
        if (state === "closed") {
          return;
        }
        if (result.done) {
          close();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
        arm(controller);
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel: async (reason) => {
      close();
      // The producer learns the consumer left through its own `cancel`: for the
      // chat stream that is what aborts the provider request.
      await reader.cancel(reason);
    },
  });
};

/**
 * Serve a stream this service authors as Server-Sent Events. Owns the response
 * headers as well as the heartbeat, so an event stream cannot be served with a
 * cacheable or buffered one.
 */
export const sseResponse = (body: ReadableStream<Uint8Array>): Response =>
  new Response(withHeartbeatFrames(body), { headers: SSE_HEADERS });

/**
 * Add the heartbeat to an event-stream `Response` built elsewhere: the chat
 * stream, which a library encodes and whose cancel path aborts the provider,
 * and the MCP notification channel, whose transport owns its body. Status,
 * status text, and headers carry over untouched.
 */
export const withSseHeartbeat = (response: Response): Response => {
  const body =
    response.body ?? panic("Event-stream response was built without a body");
  return new Response(withHeartbeatFrames(body), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};
