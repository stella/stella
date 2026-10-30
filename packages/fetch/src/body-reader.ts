import { raceAbort } from "./race-abort";

type BodyIdleDeadlineOptions = {
  idleMs: number;
  signal?: AbortSignal | undefined;
};

const invalidIdleMs = (idleMs: number): DOMException | undefined => {
  if (!Number.isFinite(idleMs) || idleMs < 0 || idleMs > 2_147_483_647) {
    return new DOMException(
      "Invalid body idle deadline duration",
      "NotSupportedError",
    );
  }
  return undefined;
};

const responseReader = (body: ReadableStream<Uint8Array>) => body.getReader();

/**
 * Yields response chunks while bounding the wait for each successive chunk.
 * @yields Each byte chunk from the transport body.
 */
export async function* iterateBodyWithIdleDeadline(
  response: Response,
  { idleMs, signal }: BodyIdleDeadlineOptions,
): AsyncGenerator<Uint8Array, void, void> {
  const invalidDuration = invalidIdleMs(idleMs);
  if (invalidDuration !== undefined) {
    await Promise.reject(invalidDuration);
  }
  signal?.throwIfAborted();
  const body = response.body;
  if (body === null) {
    return;
  }

  const reader = responseReader(body);
  let exitReason: unknown;
  try {
    for (;;) {
      const deadline = new AbortController();
      const timeoutError = new DOMException(
        "Response body stalled",
        "TimeoutError",
      );
      const timer = setTimeout(() => deadline.abort(timeoutError), idleMs);
      const combined =
        signal === undefined
          ? deadline.signal
          : AbortSignal.any([signal, deadline.signal]);
      try {
        const next = await raceAbort(reader.read(), combined);
        if (next.done) {
          return;
        }
        yield next.value;
      } finally {
        exitReason = combined.reason;
        clearTimeout(timer);
      }
    }
  } finally {
    try {
      await reader.cancel(exitReason);
    } finally {
      reader.releaseLock();
    }
  }
}

/** Reads a response body while bounding the wait for each successive chunk. */
export const readBodyWithIdleDeadline = async (
  response: Response,
  options: BodyIdleDeadlineOptions,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of iterateBodyWithIdleDeadline(response, options)) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const readBodyTextWithIdleDeadline = async (
  response: Response,
  options: BodyIdleDeadlineOptions,
): Promise<string> =>
  new TextDecoder().decode(await readBodyWithIdleDeadline(response, options));

export const readBodyJsonWithIdleDeadline = async (
  response: Response,
  options: BodyIdleDeadlineOptions,
): Promise<unknown> =>
  JSON.parse(await readBodyTextWithIdleDeadline(response, options));
