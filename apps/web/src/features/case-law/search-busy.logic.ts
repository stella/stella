import { Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import {
  RETRY_AFTER_MS_DETAIL,
  serviceBusyRetryAfterMs,
  shouldRetryAPIRequest,
  type ToAPIErrorProps,
} from "@/lib/errors/api";

const BUSY_SEARCH_RETRIES = 1;

/** A search the server turned away for now and said when to ask again. */
export const isSearchBusy = (error: unknown): boolean =>
  serviceBusyRetryAfterMs(error) !== undefined;

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
      [RETRY_AFTER_MS_DETAIL]: retryAfterMs,
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
