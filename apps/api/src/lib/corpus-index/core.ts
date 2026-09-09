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

/**
 * Split an index group into byte-bounded ingest requests.
 *
 * A batch is sized in rows, but a passage family turns one row into as many
 * documents as the document has passages, so the serialized body is no longer
 * bounded by the row count: a batch of long judgments can be two orders of
 * magnitude larger than the same batch of short ones. The whole body is held
 * in memory and sent as one request, so the bound has to be bytes.
 *
 * Splits only at row boundaries. Ingest appends per document with no
 * cross-document transaction, so splitting is safe for the engine — but the
 * caller records a row as applied once its documents land, and a row cut
 * across two requests could be recorded while half its passages are missing. A
 * single row that exceeds the budget on its own therefore still goes in one
 * request: sending it whole is the only shape that keeps that record honest,
 * and it is bounded by the size of one court decision.
 */
export const splitIngestRequests = <TRow>(
  group: readonly BuiltRow<TRow>[],
  maxBytes: number,
): IngestRequest<TRow>[] => {
  const requests: IngestRequest<TRow>[] = [];
  let entries: BuiltRow<TRow>[] = [];
  let lines: string[] = [];
  let bytes = 0;

  for (const entry of group) {
    const rowLines = entry.docs.map((doc) => JSON.stringify(doc));
    // Measured in UTF-8 bytes, not code units: legal text is mostly non-ASCII
    // outside English, where `.length` under-counts the wire size by up to 3x.
    const rowBytes = rowLines.reduce(
      (total, line) => total + Buffer.byteLength(line, "utf-8") + 1,
      0,
    );
    if (entries.length > 0 && bytes + rowBytes > maxBytes) {
      requests.push({ entries, ndjson: lines.join("\n") });
      entries = [];
      lines = [];
      bytes = 0;
    }
    entries.push(entry);
    for (const line of rowLines) {
      lines.push(line);
    }
    bytes += rowBytes;
  }

  if (entries.length > 0) {
    requests.push({ entries, ndjson: lines.join("\n") });
  }
  return requests;
};

/**
 * Canonical payload one row contributes to the index. `ast` is loaded only by
 * families that project one document per passage and is `null` everywhere
 * else, so a family that indexes whole documents never pays for a second
 * object read.
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
