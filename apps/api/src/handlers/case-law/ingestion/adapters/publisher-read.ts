/**
 * The typed way a case-law adapter reads its publisher.
 *
 * {@link readPublisher} sends the request through `fetchPublisher` (same gate,
 * budget and retry policy) and states what the answer established as a
 * {@link ReadOutcome}: the response, an absence the publisher stated (404 or
 * 410 only), or a failure to read. A failure cannot be mistaken for an
 * absence, so a helper built on it cannot hand its caller "nothing here" for
 * a 500, a timeout or an empty 204.
 *
 * Cancellation by the caller's signal and the publisher's refusal stops still
 * reject: they end the cycle rather than describe one read.
 */

import { panic, Result } from "better-result";

import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";

import {
  readAbsent,
  readOutcomeOfStatus,
  readPresent,
  readUnavailable,
  type ReadOutcome,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

import { fetchPublisher, type PublisherFetchInit } from "./retry";

/** Errors that stop the cycle instead of describing one read. */
const endsTheCycle = (error: unknown, signal: AbortSignal | undefined) =>
  signal?.aborted === true ||
  (error instanceof AdapterFetchError &&
    error.stopKind === INGESTION_STOP_KIND.PUBLISHER_REFUSAL);

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
  if (endsTheCycle(error, signal)) {
    throw error;
  }
  return Result.err(readUnavailable({ kind: "thrown", error }));
};

/** One publisher request, typed by what its answer established. */
export const readPublisher = async (
  url: string | URL,
  init: PublisherFetchInit,
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
  const outcome = readOutcomeOfStatus(response.status);
  switch (outcome.type) {
    case "present":
      return readPresent(response);
    case "absent":
      await response.body?.cancel();
      return readAbsent(outcome.evidence);
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
  init: PublisherFetchInit,
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
