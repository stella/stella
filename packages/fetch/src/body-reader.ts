import { TaggedError } from "better-result";

import { raceAbort } from "./race-abort";

export class BodyByteLimitError extends TaggedError("body_byte_limit")<{
  message: string;
  limit: number;
}> {}

type BodyIdleDeadlineOptions = {
  idleMs: number;
  maxBytes?: number | undefined;
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
  { idleMs, maxBytes, signal }: BodyIdleDeadlineOptions,
): AsyncGenerator<Uint8Array, void, void> {
  const invalidDuration = invalidIdleMs(idleMs);
  if (invalidDuration !== undefined) {
    await Promise.reject(invalidDuration);
  }
  signal?.throwIfAborted();
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  ) {
    await Promise.reject(
      new DOMException("Invalid response body byte limit", "NotSupportedError"),
    );
  }
  const body = response.body;
  if (body === null) {
    return;
  }

  const reader = responseReader(body);
  let exitReason: unknown;
  let byteLength = 0;
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
        byteLength += next.value.byteLength;
        if (maxBytes !== undefined && byteLength > maxBytes) {
          const limitError = new BodyByteLimitError({
            message: `Response body exceeds the ${maxBytes}-byte limit`,
            limit: maxBytes,
          });
          exitReason = limitError;
          await Promise.reject(limitError);
        }
        yield next.value;
      } finally {
        exitReason ??= combined.reason;
        clearTimeout(timer);
      }
    }
  } finally {
    reader
      .cancel(exitReason)
      .then(() => reader.releaseLock())
      .catch((cancellationError: unknown) => {
        // Cancellation only releases transport resources; the read's failure
        // remains authoritative even when transport cleanup also fails.
        cancellationError satisfies unknown;
        reader.releaseLock();
      });
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
