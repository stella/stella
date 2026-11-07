import { TaggedError } from "better-result";

import { parseApiErrorValue } from "@stll/api-contract";
import { PUBLIC_COUNTRY_UNAVAILABLE_CODE } from "@stll/api-contract/public-country-capability";
import { isConnectionFailure } from "@stll/fetch";

import { APIError, toAPIError } from "@/lib/errors/api";
import type { ToAPIErrorProps } from "@/lib/errors/api";
import { CriticalQueryTimeoutError } from "@/lib/react-query";

const PUBLIC_LAW_DISABLED_STATUS = 404;
const PUBLIC_LAW_DISABLED_MARKER = "Not Found";
const PUBLIC_LAW_AREA = "public-law";

/**
 * What the API answers when the corpus index could not be reached. It grades
 * an engine that is busy or down as 503 and a request the engine refused as
 * 502, so the status is the whole classification: 503 means the answer is
 * missing and asking again is the fix.
 */
export const SEARCH_UNAVAILABLE_STATUS = 503;

/** Bound background reads as well as loader reads, including the response body. */
export const PUBLIC_LAW_READ_TIMEOUT_MS = 10_000;

/**
 * What the API answers when the public corpus is at its concurrency limit:
 * the request was admitted nowhere, so asking again shortly is the fix, the
 * same as an unreachable index.
 */
const CORPUS_BUSY_STATUS = 429;

/**
 * The deployment answers the public-law routes but keeps the surface off.
 * Distinct from `APIError` so the boundary can name the cause: the request
 * was well-formed and the server healthy; the feature is not enabled here.
 */
export class PublicLawUnavailableError extends TaggedError(
  "PublicLawUnavailableError",
)<{
  action: string;
  area: typeof PUBLIC_LAW_AREA;
  message: string;
}> {}

/** The disposition for a failed public-law read. */
export type PublicLawFailureDisposition = "retryable" | "rejected" | "render";

const isTimeoutError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "TimeoutError";

/**
 * Separates transient public-law read failures from deliberate API answers
 * and failures that indicate the route itself cannot render safely.
 */
export const publicLawFailureDisposition = (
  error: unknown,
): PublicLawFailureDisposition => {
  if (
    CriticalQueryTimeoutError.is(error) ||
    isTimeoutError(error) ||
    isConnectionFailure(error) ||
    (APIError.is(error) &&
      (error.transportKind === "network" || error.transportKind === "timeout"))
  ) {
    return "retryable";
  }
  if (PublicLawUnavailableError.is(error)) {
    return "rejected";
  }
  if (APIError.is(error)) {
    if (error.status === CORPUS_BUSY_STATUS || error.status >= 500) {
      return "retryable";
    }
    if (error.status >= 400 && error.status < 500) {
      return "rejected";
    }
  }
  return "render";
};

/** Whether a failed public-law read can recover by retrying the read. */
export const isSearchUnavailableError = (error: unknown): boolean =>
  publicLawFailureDisposition(error) === "retryable";

/**
 * The body the public route groups answer from their gate when the surface
 * is off. The API client types it into the success branch of every
 * public-law route, so the unwrap below excludes it from the data type.
 */
type DisabledPublicLawData = {
  readonly error: typeof PUBLIC_LAW_DISABLED_MARKER;
};

/**
 * What a public-law API read answers once `unwrapPublicLawResponse` has settled
 * it. Web types that stand for a response derive from this, so a field the
 * API adds, drops, or tightens reaches every consumer.
 */
export type PublicLawData<
  TRead extends (...args: never[]) => Promise<{ data: unknown }>,
> = Exclude<
  NonNullable<Awaited<ReturnType<TRead>>["data"]>,
  DisabledPublicLawData
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDisabledPublicLawData = (
  value: unknown,
): value is DisabledPublicLawData =>
  isRecord(value) && value["error"] === PUBLIC_LAW_DISABLED_MARKER;

// A generic predicate, so the exclusion narrows the payload type of each
// route instead of one fixed type.
const isPublicLawData = <T>(
  data: T,
): data is Exclude<T, DisabledPublicLawData> => !isDisabledPublicLawData(data);

// The gate answers with status 404, so the API client files the marker under
// `error`; a missing resource on an enabled surface carries a different body,
// so the marker is unambiguous.
type PublicLawErrorInput = ToAPIErrorProps;

type PublicLawApiResponse<T> =
  { data: T; error: null } | { data: null; error: PublicLawErrorInput };

const isDisabledPublicLawResponse = (error: PublicLawErrorInput): boolean =>
  error.status === PUBLIC_LAW_DISABLED_STATUS &&
  isDisabledPublicLawData(error.value);

const publicLawUnavailable = (action: string) =>
  new PublicLawUnavailableError({
    action,
    area: PUBLIC_LAW_AREA,
    message: "Public law is not available.",
  });

/**
 * Classifies a failed public-law API response. The API client files every
 * non-2xx answer under `error`, so the disabled marker has to be read there, before
 * the generic `APIError` is raised. Call sites that branch on the failure
 * themselves (a 404 that is a real answer, a search that degrades to empty)
 * classify first and decide second.
 */
export const toPublicLawError = (
  error: PublicLawErrorInput,
  action: string,
): APIError | PublicLawUnavailableError => {
  if (isDisabledPublicLawResponse(error)) {
    return publicLawUnavailable(action);
  }

  return toAPIError({
    ...error,
    value: parseApiErrorValue(error.value),
  });
};

const NOT_FOUND_STATUS = 404;

/**
 * Whether a classified public-law failure is a plain miss. A country the API
 * advertises but does not serve answers 404 as well; its typed code keeps it
 * a failure the reader is told about, not a link that leads nowhere.
 */
export const isPublicLawMissError = (error: unknown): boolean =>
  APIError.is(error) &&
  error.status === NOT_FOUND_STATUS &&
  error.code !== PUBLIC_COUNTRY_UNAVAILABLE_CODE;

/**
 * Whether a failed public-law response is a plain miss rather than a
 * transport, gate, or server failure. Classifying first is what lets a caller
 * treat the miss as an answer while `unwrapPublicLawResponse` still raises
 * everything else, the disabled-surface marker included.
 */
export const isPublicLawMiss = (
  error: PublicLawErrorInput,
  action: string,
): boolean => isPublicLawMissError(toPublicLawError(error, action));

/**
 * Unwraps a public-law API response, throwing the classified failure.
 * Taking the whole response is what makes the classification structural: a
 * helper handed unwrapped data could never see the disabled marker. The
 * marker is also excluded from the data type (and checked at runtime, in
 * case a gate ever answers it with a success status), so callers read the
 * payload type alone.
 */
export function unwrapPublicLawResponse<T>(
  response: PublicLawApiResponse<T>,
  action: string,
): Exclude<T, DisabledPublicLawData> {
  if (response.error) {
    throw toPublicLawError(response.error, action);
  }
  const { data } = response;
  if (!isPublicLawData(data)) {
    throw publicLawUnavailable(action);
  }
  return data;
}
