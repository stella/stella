// parser-output-unchanged: a 429 ends the cycle as a typed stop; a served read returns the same response.
/**
 * The typed way a case-law adapter reads its publisher.
 *
 * {@link readPublisher} sends the request through `fetchPublisher` (same gate,
 * budget and retry policy) and states what the answer established as a
 * {@link ReadOutcome}: the response, an absence the publisher stated (404 or
 * 410 only), a refusal (401, 403, 451), or a failure to read. A failure or a
 * refusal cannot be mistaken for an absence, so a helper built on it cannot
 * hand its caller "nothing here" for a 500, a timeout, an empty 204 or a 403.
 *
 * Bodies are read through {@link readPublisherText} or
 * {@link readPublisherBytes}, which stop at a byte ceiling. The `Response`
 * that {@link readPublisher} returns is for its headers or a bounded stream
 * reader; `no-unbounded-response-body` reports a whole-body read of it.
 *
 * Where a refusal ends the cycle and where it describes one read:
 * - It ends the cycle (rejects) when it is a source-level stop: the caller
 *   opted into `refusalMode: "stop-refusal"` (a session workflow, where a
 *   401/403/429 on any request means the source is refusing the crawl), or the
 *   shared publisher gate refused for a rate-limit cooldown. Both arrive as an
 *   `AdapterFetchError` whose stop kind is `publisher_refusal`, and they halt
 *   the whole source, as before.
 * - Every other 401, 403 or 451 answer is about the one address read: it
 *   becomes a `refused` outcome with the caller's `refusalScope` (default
 *   "document"), for the adapter to store as a typed marker.
 * - A 429 is the publisher's rate-limit refusal (rule 19a): a typed halt. A
 *   read sends `refusalMode: "stop-rate-limit"` at least, so it rejects with
 *   an `AdapterFetchError` carrying the status after one request; the page
 *   fails with its cursor untouched and no later read in the cycle spends the
 *   budget the refusal protects.
 *
 * Cancellation by the caller's signal also rejects.
 */

import { panic, Result } from "better-result";

import { readCappedBytes } from "@stll/skills/streaming";

import {
  readAbsent,
  readOutcomeOfStatus,
  readPresent,
  readRefused,
  readUnavailable,
  type ReadOutcome,
  type ReadRefusalScope,
} from "@/api/lib/errors/read-outcome";

import {
  fetchPublisher,
  rethrowCycleStop,
  type PublisherFetchInit,
} from "./retry";

/**
 * Run one step of a read: its value, or the failure as `unavailable`. Errors
 * that end the cycle propagate.
 */
const readStep = async <T>(
  step: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<Result<T, ReadOutcome<never>>> => {
  const result = await Result.tryPromise({
    try: step,
    catch: (cause: unknown) => cause,
  });
  if (Result.isOk(result)) {
    return Result.ok(result.value);
  }
  const { error } = result;
  rethrowCycleStop(error, signal);
  return Result.err(readUnavailable({ kind: "thrown", error }));
};

export type PublisherReadInit = Omit<PublisherFetchInit, "refusalMode"> & {
  /** "stop-refusal" for a session workflow; a 429 ends the cycle either way. */
  refusalMode?: "stop-refusal" | undefined;
  /** What a 401, 403 or 451 answer withholds; "document" when omitted. */
  refusalScope?: ReadRefusalScope | undefined;
};

/** One publisher request, typed by what its answer established. */
export const readPublisher = async (
  url: string | URL,
  { refusalScope = "document", refusalMode, ...init }: PublisherReadInit,
): Promise<ReadOutcome<Response>> => {
  const fetched = await readStep(
    async () =>
      // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- the publisher read boundary: the lint rule checks each target where readPublisher, readPublisherBytes or readPublisherText is called
      await fetchPublisher(url, {
        ...init,
        refusalMode: refusalMode ?? "stop-rate-limit",
      }),
    init.signal ?? undefined,
  );
  if (Result.isError(fetched)) {
    return fetched.error;
  }
  const response = fetched.value;
  const outcome = readOutcomeOfStatus(
    response.status,
    refusalScope,
    response.headers.get("Retry-After"),
  );
  switch (outcome.type) {
    case "present":
      return readPresent(response);
    case "absent":
      await response.body?.cancel();
      return readAbsent(outcome.evidence);
    case "refused":
      await response.body?.cancel();
      return readRefused({
        status: outcome.status,
        scope: outcome.scope,
        cause: outcome.cause,
      });
    case "unavailable":
      await response.body?.cancel();
      return readUnavailable(outcome.cause);
    default:
      outcome satisfies never;
      return panic(`Unhandled read outcome: ${String(outcome)}`);
  }
};

/**
 * The most a publisher body read through this module may hold in memory. It
 * matches the largest per-adapter ceiling (a full listing export) and the raw
 * payload verification ceiling, so anything larger could not be stored and
 * verified as a raw source payload anyway.
 */
export const PUBLISHER_BODY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * One publisher request whose body is read whole, up to
 * {@link PUBLISHER_BODY_MAX_BYTES}. A body over the ceiling stops the read at
 * the ceiling and is `too-large`; a served but empty body is `empty-body`; a
 * body that fails after the headers is `thrown`. All three are failures to
 * read, never a document.
 */
export const readPublisherBytes = async (
  url: string | URL,
  init: PublisherReadInit,
): Promise<ReadOutcome<Uint8Array>> => {
  const outcome = await readPublisher(url, init);
  if (outcome.type !== "present") {
    return outcome;
  }
  const { body, status } = outcome.value;
  if (body === null) {
    return readUnavailable({ kind: "empty-body", status });
  }
  const bytes = await readStep(
    async () => await readCappedBytes(body, PUBLISHER_BODY_MAX_BYTES),
    init.signal ?? undefined,
  );
  if (Result.isError(bytes)) {
    return bytes.error;
  }
  if (bytes.value === null) {
    return readUnavailable({
      kind: "too-large",
      maxBytes: PUBLISHER_BODY_MAX_BYTES,
    });
  }
  return bytes.value.length === 0
    ? readUnavailable({ kind: "empty-body", status })
    : readPresent(bytes.value);
};

/**
 * One publisher request whose body is UTF-8 text, with the bounds and
 * failures of {@link readPublisherBytes}. Decoding matches `Response.text()`.
 */
export const readPublisherText = async (
  url: string | URL,
  init: PublisherReadInit,
): Promise<ReadOutcome<string>> => {
  const outcome = await readPublisherBytes(url, init);
  return outcome.type === "present"
    ? readPresent(new TextDecoder().decode(outcome.value))
    : outcome;
};
