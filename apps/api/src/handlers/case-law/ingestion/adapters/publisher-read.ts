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
 * - A 429 is the publisher's rate-limit refusal (rule 19a): a typed halt. It
 *   rejects with an `AdapterFetchError` carrying the status after one
 *   request, so the page fails with its cursor untouched and no later read in
 *   the cycle spends the budget the refusal protects.
 *
 * Cancellation by the caller's signal also rejects.
 */

import { panic, Result } from "better-result";

import {
  readAbsent,
  readOutcomeOfStatus,
  readPresent,
  readRefused,
  readUnavailable,
  type ReadOutcome,
  type ReadRefusalScope,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

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

/** The publisher's rate-limit refusal of a request. */
const RATE_LIMITED_STATUS = 429;

export type PublisherReadInit = PublisherFetchInit & {
  /** What a 401, 403 or 451 answer withholds; "document" when omitted. */
  refusalScope?: ReadRefusalScope | undefined;
};

/** One publisher request, typed by what its answer established. */
export const readPublisher = async (
  url: string | URL,
  { refusalScope = "document", ...init }: PublisherReadInit,
): Promise<ReadOutcome<Response>> => {
  const fetched = await readStep(
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- the publisher read boundary: the lint rule checks each target where readPublisher or readPublisherText is called
    async () => await fetchPublisher(url, init),
    init.signal ?? undefined,
  );
  if (Result.isError(fetched)) {
    return fetched.error;
  }
  const response = fetched.value;
  if (response.status === RATE_LIMITED_STATUS) {
    const retryAfter = response.headers.get("Retry-After");
    await response.body?.cancel();
    throw new AdapterFetchError({
      message: `Publisher rate limit refused: ${response.status}`,
      adapterKey: init.adapterKey,
      cursor: null,
      httpStatus: response.status,
      ...(retryAfter === null ? {} : { retryAfter }),
    });
  }
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
 * One publisher request whose body is text. A served but empty body is a
 * failure to read, not an empty document.
 */
export const readPublisherText = async (
  url: string | URL,
  init: PublisherReadInit,
): Promise<ReadOutcome<string>> => {
  const outcome = await readPublisher(url, init);
  if (outcome.type !== "present") {
    return outcome;
  }
  const response = outcome.value;
  const text = await readStep(
    async () => await response.text(),
    init.signal ?? undefined,
  );
  if (Result.isError(text)) {
    return text.error;
  }
  return text.value.length === 0
    ? readUnavailable({ kind: "empty-body", status: response.status })
    : readPresent(text.value);
};
