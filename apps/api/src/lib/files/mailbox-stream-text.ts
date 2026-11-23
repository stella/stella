import { type Result, TaggedError } from "better-result";

import type { ExtractionWorkerError } from "@/api/lib/errors/tagged-errors";
import type { FileKey } from "@/api/lib/file-key";
import { openS3ObjectStream } from "@/api/lib/s3";
import { extractMailboxStreamText } from "@/api/lib/search/extract-content";

/** The live file's stored object is not in the store. */
export class StoredMailboxMissingError extends TaggedError(
  "StoredMailboxMissingError",
)<{ message: string }> {}

/** Streams a stored mailbox, one network chunk in memory at a time. */
export const openStoredMailbox = async ({
  key,
  signal,
}: {
  key: FileKey;
  signal: AbortSignal;
}) => {
  const opened = await openS3ObjectStream({ key, signal });
  if (opened === null) {
    throw new StoredMailboxMissingError({
      message: "The stored mailbox is missing from the store",
    });
  }
  return opened;
};

/** Chunks as a stream that pulls one at a time; cancelling stops the source. */
const streamOf = (chunks: AsyncIterable<Uint8Array>) => {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
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
}: {
  key: FileKey;
  fileName: string;
  maxChars?: number;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<Result<string | null, ExtractionWorkerError>> => {
  const opened = await openStoredMailbox({ key, signal });
  return await extractMailboxStreamText({
    stream: streamOf(opened.chunks),
    sizeBytes: opened.sizeBytes,
    fileName,
    signal,
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
};
