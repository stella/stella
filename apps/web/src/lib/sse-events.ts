/**
 * The `text/event-stream` wire format, read in one place.
 *
 * `EventSource` covers the streams the browser may reconnect to on its own
 * (see `@/lib/sse.ts`), but a stream opened with `POST` and a JSON body is not
 * one of them: it has to be read off `fetch`'s `ReadableStream`. That leaves
 * the framing — blank-line-separated blocks, `event:` and `data:` lines — for
 * the caller, and it is the same framing for every such endpoint. One parser,
 * so a second streaming endpoint cannot quietly grow a third dialect of it.
 */

/** One parsed frame: the `event:` name (`"message"` when the frame states
 *  none) and its `data:` lines joined back together. */
export type SSEEvent = { event: string; data: string };

const DEFAULT_EVENT_NAME = "message";
const EVENT_FIELD = "event:";
const DATA_FIELD = "data:";
const FRAME_SEPARATOR = "\n\n";

/** Parse whole frames out of an already-complete chunk of the stream. The
 *  caller is responsible for handing over only complete frames. */
export const parseSSEEvents = (raw: string): SSEEvent[] => {
  const events: SSEEvent[] = [];
  for (const block of raw.split(FRAME_SEPARATOR)) {
    if (block.length === 0) {
      continue;
    }
    let event = DEFAULT_EVENT_NAME;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(EVENT_FIELD)) {
        event = line.slice(EVENT_FIELD.length).trim();
      } else if (line.startsWith(DATA_FIELD)) {
        dataLines.push(line.slice(DATA_FIELD.length).trim());
      }
    }
    events.push({ event, data: dataLines.join("\n") });
  }
  return events;
};

/**
 * Read a response body as SSE frames, handing each one to `onEvent`.
 *
 * `onEvent` answers whether to keep reading: `false` stops the read and
 * cancels the body, which is what closes the connection and, for a stream
 * backed by a model call, stops the tokens being paid for.
 */
export const readSSEEvents = async (
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SSEEvent) => boolean,
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- sequential stream read: each chunk must be decoded before the next
      const chunk = await reader.read();
      if (chunk.done) {
        // A stream that ends mid-frame has nothing complete left to report.
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const boundary = buffer.lastIndexOf(FRAME_SEPARATOR);
      if (boundary === -1) {
        continue;
      }
      const ready = buffer.slice(0, boundary + FRAME_SEPARATOR.length);
      buffer = buffer.slice(boundary + FRAME_SEPARATOR.length);
      for (const event of parseSSEEvents(ready)) {
        if (!onEvent(event)) {
          return;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};
