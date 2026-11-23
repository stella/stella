import { panic, Result } from "better-result";

import { MBOX_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";

import {
  EXTRACTION_WORKER_ERROR_CODE,
  ExtractionWorkerError,
} from "@/api/lib/errors/tagged-errors";
import type { FileKey } from "@/api/lib/file-key";
import { openS3ObjectStream } from "@/api/lib/s3";
import { extractMailboxStreamText } from "@/api/lib/search/extract-content";

/**
 * Streams a stored mailbox, one network chunk in memory at a time. A live
 * file's object is never removed while the file is live, so one the store
 * does not hold is a broken invariant, never an answer to pass on.
 */
export const openStoredMailbox = async ({
  key,
  signal,
  openTimeoutMs,
}: {
  key: FileKey;
  /** Cancels the open and the whole read. */
  signal: AbortSignal;
  /** How long the store may take to start answering; the read then runs on. */
  openTimeoutMs?: number | undefined;
}) => {
  const read = new AbortController();
  const forward = () => {
    read.abort(signal.reason);
  };
  if (signal.aborted) {
    forward();
  }
  signal.addEventListener("abort", forward, { once: true });
  const deadline =
    openTimeoutMs === undefined
      ? null
      : setTimeout(() => {
          read.abort(
            new DOMException("The store did not answer", "TimeoutError"),
          );
        }, openTimeoutMs);
  try {
    const opened = await openS3ObjectStream({ key, signal: read.signal });
    return opened ?? panic("The stored mailbox is missing from the store");
  } finally {
    if (deadline !== null) {
      clearTimeout(deadline);
    }
  }
};

/**
 * Chunks as a stream that pulls one at a time; cancelling stops the source.
 * A source that fails errors the stream and is remembered, so a reader
 * that saw only part of the file is never taken as having read all of it.
 */
const streamOf = (chunks: AsyncIterable<Uint8Array>) => {
  const iterator = chunks[Symbol.asyncIterator]();
  const state: { failure: unknown } = { failure: undefined };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await Result.tryPromise(async () => await iterator.next());
      if (next.isErr()) {
        state.failure = next.error.cause;
        controller.error(next.error.cause);
        return;
      }
      if (next.value.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return { stream, state };
};

/**
 * A stored mailbox's text for search, chat, workflows and agents: the stored
 * object is streamed straight into the extraction worker, which reads one
 * message at a time, so neither side ever holds the mailbox whole.
 */
export const readStoredMailboxText = async ({
  key,
  fileName,
  maxChars,
  signal,
  timeoutMs,
  openTimeoutMs,
}: {
  key: FileKey;
  fileName: string;
  maxChars?: number;
  signal: AbortSignal;
  timeoutMs?: number;
  openTimeoutMs?: number;
}): Promise<Result<string | null, ExtractionWorkerError>> => {
  const opened = await openStoredMailbox({ key, signal, openTimeoutMs });
  const { stream, state } = streamOf(opened.chunks);
  const text = await extractMailboxStreamText({
    stream,
    sizeBytes: opened.sizeBytes,
    fileName,
    signal,
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (state.failure === undefined) {
    return text;
  }
  return Result.err(
    new ExtractionWorkerError({
      code: EXTRACTION_WORKER_ERROR_CODE.external,
      message: "The stored mailbox could not be read to its end",
      exitCode: null,
      mimeType: MBOX_FILE_FORMAT.mimeType,
      sizeBytes: opened.sizeBytes,
      termination: null,
      workerErrorClass: null,
    }),
  );
};
