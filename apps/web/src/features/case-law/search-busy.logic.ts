import { Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import {
  APIError,
  shouldRetryAPIRequest,
  type ToAPIErrorProps,
} from "@/lib/errors/api";

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
const retryAfterMsFrom = (headers: Headers): number | undefined => {
  const seconds = parseIntegerToken(headers.get("retry-after"), {
    sign: "unsigned",
  });
  return Result.isOk(seconds) ? seconds.value * 1000 : undefined;
};

/**
 * A refusal with a `Retry-After`, the delay carried in its body, which is what
 * reaches the query's error.
 */
export const withRetryAfterDetail = (
  error: ToAPIErrorProps,
  headers: Headers | undefined,
): ToAPIErrorProps => {
  const retryAfterMs =
    headers === undefined ? undefined : retryAfterMsFrom(headers);
  if (retryAfterMs === undefined) {
    return error;
  }
  const { value } = error;
  return {
    ...error,
    value: {
      ...(typeof value === "object" && value !== null ? value : {}),
      [RETRY_AFTER_DETAIL]: retryAfterMs,
    },
  };
};

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
