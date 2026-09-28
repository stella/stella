import { panic, TaggedError } from "better-result";
import { Buffer } from "node:buffer";

/**
 * Shared pieces of the corpus-index projection that are not specific to one
 * document family: the byte bound on an ingest request body, the settlement
 * helper that keeps concurrent remote effects observed, and the canonical
 * payload shape a row contributes to the index.
 */

/** One row and every search document it projects to. */
type BuiltRow<TRow> = { row: TRow; docs: Record<string, unknown>[] };

/** One ingest request: the rows it covers and the NDJSON body carrying them. */
export type IngestRequest<TRow> = {
  entries: BuiltRow<TRow>[];
  ndjson: string;
};

class IngestDocumentTooLargeError extends TaggedError(
  "IngestDocumentTooLargeError",
)<{ message: string }> {}

/**
 * Split an index group into byte-bounded ingest requests.
 *
 * A batch is sized in rows, but a passage family turns one row into as many
 * documents as the document has passages, so the serialized body is no longer
 * bounded by the row count: a batch of long judgments can be two orders of
 * magnitude larger than the same batch of short ones. The whole body is held
 * in memory and sent as one request, so the bound has to be bytes.
 *
 * Splits at document boundaries, including within a row. The request metadata
 * retains the row for each part so callers can track all requests contributing
 * to that row. A document allowed above the batch budget occupies a request
 * alone, up to the separate single-document ceiling.
 */
type SplitIngestRequestOptions = { maxSingleDocumentBytes?: number };

export const splitIngestRequests = <TRow>(
  group: readonly BuiltRow<TRow>[],
  maxBytes: number,
  { maxSingleDocumentBytes = maxBytes }: SplitIngestRequestOptions = {},
): IngestRequest<TRow>[] => {
  const requests: IngestRequest<TRow>[] = [];
  let entries: BuiltRow<TRow>[] = [];
  let lines: string[] = [];
  let bytes = 0;

  const flush = () => {
    if (lines.length === 0) {
      return;
    }
    requests.push({ entries, ndjson: lines.join("\n") });
    entries = [];
    lines = [];
    bytes = 0;
  };

  for (const entry of group) {
    if (entry.docs.length === 0) {
      return panic("An ingest row has no documents");
    }

    let partDocs: Record<string, unknown>[] = [];
    for (const doc of entry.docs) {
      const line = JSON.stringify(doc);
      // Measure UTF-8 bytes: legal text is often non-ASCII.
      const lineBytes = Buffer.byteLength(line, "utf-8");
      if (lineBytes > maxSingleDocumentBytes) {
        throw new IngestDocumentTooLargeError({
          message: `An ingest document is ${lineBytes} bytes, exceeding the ${maxSingleDocumentBytes}-byte document limit`,
        });
      }
      const separatorBytes = lines.length === 0 ? 0 : 1;
      if (bytes + separatorBytes + lineBytes > maxBytes) {
        flush();
        partDocs = [];
      }
      if (partDocs.length === 0) {
        entries.push({ row: entry.row, docs: partDocs });
      }
      partDocs.push(doc);
      lines.push(line);
      bytes += (lines.length === 1 ? 0 : 1) + lineBytes;
    }
  }

  flush();
  return requests;
};

/**
 * Canonical payload one row contributes to the index. The AST is loaded for
 * case-law passages and oversized legislation; whole legislation documents
 * avoid a second object read.
 */
export type CorpusDocumentPayload = {
  text: string;
  ast: unknown;
};

/**
 * `Promise.all` for two operations whose side effects must be finished before
 * the caller moves on. It rejects as soon as one input does, leaving the other
 * running unobserved; this waits for both, then surfaces the first failure in
 * argument order. Use it wherever an abandoned in-flight request would escape a
 * concurrency bound rather than merely be wasted.
 */
export const settleBoth = async <TFirst, TSecond>(
  first: Promise<TFirst>,
  second: Promise<TSecond>,
): Promise<[TFirst, TSecond]> => {
  const [firstOutcome, secondOutcome] = await Promise.allSettled([
    first,
    second,
  ]);
  // Rethrow the original rejection, tagged error and all: the caller's
  // isolation path reads its message into the failed index job, and wrapping
  // it here would bury the cause the operator needs.
  if (firstOutcome.status === "rejected") {
    throw firstOutcome.reason;
  }
  if (secondOutcome.status === "rejected") {
    throw secondOutcome.reason;
  }
  return [firstOutcome.value, secondOutcome.value];
};
