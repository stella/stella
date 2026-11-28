// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: shared capped-body reader; parsed payloads are unchanged.
import { Result } from "better-result";

import {
  type ReadOutcome,
  readPresent,
  readUnavailable,
} from "@stll/case-law-ingestion-core/read-outcome";
import { BodyByteLimitError } from "@stll/fetch/body-reader";
import { readCappedBytes } from "@stll/skills/streaming";

import { rethrowCycleStop } from "./retry";

/**
 * Read a present publisher response body up to `maxBytes`, mapping empty,
 * oversized, or failed stream reads to typed `ReadOutcome` values.
 */
export const readCappedPublisherBytes = async (options: {
  body: ReadableStream<Uint8Array> | null;
  status: number;
  maxBytes: number;
  signal: AbortSignal | undefined;
}): Promise<ReadOutcome<Uint8Array>> => {
  const { body, status, maxBytes, signal } = options;
  if (body === null) {
    return readUnavailable({ kind: "empty-body", status });
  }
  const read = await Result.tryPromise({
    try: async () => await readCappedBytes(body, maxBytes),
    catch: (error: unknown) => error,
  });
  if (Result.isError(read)) {
    rethrowCycleStop(read.error, signal);
    if (BodyByteLimitError.is(read.error)) {
      return readUnavailable({
        kind: "too-large",
        maxBytes: read.error.limit,
      });
    }
    return readUnavailable({ kind: "thrown", error: read.error });
  }
  if (read.value === null) {
    return readUnavailable({ kind: "too-large", maxBytes });
  }
  if (read.value.length === 0) {
    return readUnavailable({ kind: "empty-body", status });
  }
  return readPresent(read.value);
};
