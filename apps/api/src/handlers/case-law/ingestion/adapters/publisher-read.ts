// parser-output-unchanged: readGatedResponse export removed; its implementation and internal calls are unchanged.
// parser-output-unchanged: Typed gate refusals retain their scope and retry metadata; successful response bodies and decision parsing are unchanged.
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
 * {@link readPublisherBytes}, which stop at a byte ceiling; a caller that
 * inspects the headers first hands the outcome to {@link readBodyText}.
 * `no-unbounded-response-body` reports a whole-body read of the `Response`
 * that {@link readPublisher} returns.
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

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";
import { readCappedBytes } from "@stll/skills/streaming";

import {
  isReadRefusal,
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
  if (
    error instanceof AdapterFetchError &&
    isReadRefusal(error.cause) &&
    error.cause.scope !== "source"
  ) {
    return Result.err(error.cause);
  }
  return Result.err(readUnavailable({ kind: "thrown", error }));
};

// parser-output-unchanged: a type-only change to the read options; no parsed record changes.
/**
 * An intersection, not `Omit`: `Omit` over the timeout union collapses it, and
 * the intersection narrows `refusalMode` all the same.
 */
export type PublisherReadInit = PublisherFetchInit & {
  /** "stop-refusal" for a session workflow; a 429 ends the cycle either way. */
  refusalMode?: "stop-refusal" | undefined;
  /** What a 401, 403 or 451 answer withholds; "document" when omitted. */
  refusalScope?: ReadRefusalScope | undefined;
};

type GatedReadOptions = {
  /** The request, already behind its publisher's gate. */
  request: () => Promise<Response>;
  signal: AbortSignal | undefined;
  /** What a 401, 403 or 451 answer withholds. */
  refusalScope: ReadRefusalScope;
};

/**
 * One request sent through a publisher gate, typed by what its answer
 * established. {@link readPublisher} is this read over the shared gate; an
 * adapter whose publisher has a gate of its own passes that gate's request.
 */
const readGatedResponse = async ({
  request,
  signal,
  refusalScope,
}: GatedReadOptions): Promise<ReadOutcome<Response>> => {
  const fetched = await readStep(request, signal);
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
 * The body of a present read, whole, up to {@link PUBLISHER_BODY_MAX_BYTES}.
 * A body over the ceiling stops the read at the ceiling and is `too-large`; a
 * served but empty body is `empty-body`; a body that fails after the headers
 * is `thrown`. All three are failures to read, never a document. Any other
 * outcome passes through unread.
 */
const readBodyBytes = async (
  outcome: ReadOutcome<Response>,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome<Uint8Array>> => {
  if (outcome.type !== "present") {
    return outcome;
  }
  const { body, status } = outcome.value;
  if (body === null) {
    return readUnavailable({ kind: "empty-body", status });
  }
  const bytes = await readStep(
    async () => await readCappedBytes(body, PUBLISHER_BODY_MAX_BYTES),
    signal,
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
 * The body of a present read as UTF-8 text, with the bounds and failures of
 * {@link readBodyBytes}. Decoding matches `Response.text()`.
 */
export const readBodyText = async (
  outcome: ReadOutcome<Response>,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome<string>> => {
  const bytes = await readBodyBytes(outcome, signal);
  return bytes.type === "present"
    ? readPresent(new TextDecoder().decode(bytes.value))
    : bytes;
};

const sharedGateRead = (
  url: string | URL,
  { refusalScope = "document", refusalMode, ...init }: PublisherReadInit,
): GatedReadOptions => ({
  request: async () =>
    // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- the publisher read boundary: the lint rule checks each target where readPublisher, readPublisherBytes or readPublisherText is called
    await fetchPublisher(url, {
      ...init,
      refusalMode: refusalMode ?? "stop-rate-limit",
    }),
  signal: init.signal ?? undefined,
  refusalScope,
});

/** One publisher request, typed by what its answer established. */
export const readPublisher = async (
  url: string | URL,
  init: PublisherReadInit,
): Promise<ReadOutcome<Response>> =>
  await readGatedResponse(sharedGateRead(url, init));

/** {@link readGatedResponse} whose body is text; see {@link readBodyText}. */
export const readGatedResponseText = async (
  options: GatedReadOptions,
): Promise<ReadOutcome<string>> =>
  await readBodyText(await readGatedResponse(options), options.signal);

/** One publisher request whose body is binary; see {@link readBodyBytes}. */
export const readPublisherBytes = async (
  url: string | URL,
  init: PublisherReadInit,
): Promise<ReadOutcome<Uint8Array>> =>
  await readBodyBytes(await readPublisher(url, init), init.signal ?? undefined);

/** One publisher request whose body is text; see {@link readBodyText}. */
export const readPublisherText = async (
  url: string | URL,
  init: PublisherReadInit,
): Promise<ReadOutcome<string>> =>
  await readBodyText(await readPublisher(url, init), init.signal ?? undefined);

/** A read that established no value: an absence, a refusal or a failure. */
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
    case "too-large":
      return new AdapterFetchError({
        message: `${message}: body over ${cause.maxBytes} bytes`,
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
 * classifies the failure as it would the raw response or exception. A
 * refusal carries its typed `ReadRefusal` as the cause, and stops the
 * source only when its scope is the source.
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
    case "refused":
      return new AdapterFetchError({
        ...context,
        message: `${context.message}: ${outcome.status} refused (${outcome.scope})`,
        httpStatus: outcome.status,
        ...(outcome.cause.retryAfter === null
          ? {}
          : { retryAfter: outcome.cause.retryAfter }),
        cause: outcome,
        // A refused document or part is that one address; only a refusal of
        // the source stops the crawl.
        stopKind:
          outcome.scope === "source"
            ? INGESTION_STOP_KIND.PUBLISHER_REFUSAL
            : INGESTION_STOP_KIND.ADAPTER_ERROR,
      });
    case "unavailable":
      return unavailableReadError({ ...context, cause: outcome.cause });
    default:
      outcome satisfies never;
      return panic(`Unhandled unread outcome: ${String(outcome)}`);
  }
};
