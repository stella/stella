import { APIError, shouldRetryAPIRequest } from "@/lib/errors/api";

const SERVICE_UNAVAILABLE_STATUS = 503;
const BUSY_SEARCH_RETRIES = 1;
const RETRY_AFTER_DETAIL = "retryAfterMs";
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 30_000;

const busyRetryAfterMs = (error: unknown): number | undefined => {
  if (!APIError.is(error) || error.status !== SERVICE_UNAVAILABLE_STATUS) {
    return undefined;
  }
  const value = error.details?.[RETRY_AFTER_DETAIL];
  return typeof value === "number" ? value : undefined;
};

/** A search the server turned away for now and said when to ask again. */
export const isSearchBusy = (error: unknown): boolean =>
  busyRetryAfterMs(error) !== undefined;

/** A `Retry-After` in seconds as a delay, or nothing when it says no such thing. */
export const retryAfterMsFrom = (headers: Headers): number | undefined => {
  const seconds = Number(headers.get("retry-after") ?? Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

/** The refusal's body, carrying the delay into the error the query holds. */
export const withRetryAfterDetail = (
  value: unknown,
  retryAfterMs: number,
): Record<string, unknown> => ({
  ...(typeof value === "object" && value !== null ? value : {}),
  [RETRY_AFTER_DETAIL]: retryAfterMs,
});

export const shouldRetrySearch = (
  failureCount: number,
  error: unknown,
): boolean =>
  isSearchBusy(error)
    ? failureCount < BUSY_SEARCH_RETRIES
    : shouldRetryAPIRequest(failureCount, error);

export const searchRetryDelayMs = (
  attemptIndex: number,
  error: unknown,
): number =>
  busyRetryAfterMs(error) ??
  Math.min(DEFAULT_RETRY_BASE_MS * 2 ** attemptIndex, DEFAULT_RETRY_MAX_MS);
