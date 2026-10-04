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
 * A 429 outside those stops stays `unavailable` (retried later).
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
  type AbsenceEvidence,
  type ReadOutcome,
  type ReadRefusalScope,
  type ReadUnavailableCause,
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

/** A read that established no value: an absence or a failure. */
export type UnreadPublisherOutcome = Exclude<
  ReadOutcome<unknown>,
  { readonly type: "present" }
>;

const ABSENCE_HTTP_STATUS = {
  "http-404": 404,
  "http-410": 410,
  "stated-zero": undefined,
  "publisher-typed-absence": undefined,
} as const satisfies Record<AbsenceEvidence, number | undefined>;

type UnreadPublisherErrorOptions = {
  outcome: UnreadPublisherOutcome;
  /** What failed, e.g. "NSS search failed"; the status or cause is appended. */
  message: string;
  adapterKey: string;
  cursor: string | null;
};

const unavailableReadError = ({
  cause,
  message,
  adapterKey,
  cursor,
}: Omit<UnreadPublisherErrorOptions, "outcome"> & {
  cause: ReadUnavailableCause;
}): AdapterFetchError => {
  switch (cause.kind) {
    case "status":
      return new AdapterFetchError({
        message: `${message}: ${cause.status}`,
        adapterKey,
        cursor,
        httpStatus: cause.status,
      });
    case "no-content":
    case "empty-body":
      return new AdapterFetchError({
        message: `${message}: ${cause.status} ${cause.kind}`,
        adapterKey,
        cursor,
      });
    case "thrown":
      return new AdapterFetchError({
        message: `${message}: ${cause.error instanceof Error ? cause.error.message : String(cause.error)}`,
        adapterKey,
        cursor,
        cause: cause.error,
      });
    default:
      cause satisfies never;
      return panic(`Unhandled read failure: ${String(cause)}`);
  }
};

/**
 * A read that established no value, as the adapter error its caller throws or
 * reports. The HTTP status or the thrown cause is kept, so the cycle
 * classifies the failure as it would the raw response or exception.
 */
export const unreadPublisherError = ({
  outcome,
  ...context
}: UnreadPublisherErrorOptions): AdapterFetchError => {
  switch (outcome.type) {
    case "absent": {
      const httpStatus = ABSENCE_HTTP_STATUS[outcome.evidence];
      return new AdapterFetchError({
        ...context,
        message: `${context.message}: ${httpStatus ?? outcome.evidence}`,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
    }
    case "unavailable":
      return unavailableReadError({ ...context, cause: outcome.cause });
    default:
      outcome satisfies never;
      return panic(`Unhandled unread outcome: ${String(outcome)}`);
  }
};
