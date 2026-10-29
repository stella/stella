/**
 * HTTP statuses that refuse a request for now rather than for good: the same
 * request can succeed later (a timeout, a too-early replay, throttling, or a
 * server error). An upstream answering one of these is a retryable outage;
 * any other 4xx asks the caller to change the request.
 */
const RETRY_LATER_CLIENT_STATUSES: readonly number[] = [408, 425, 429];

export const isRetryLaterStatus = (status: number): boolean =>
  status >= 500 || RETRY_LATER_CLIENT_STATUSES.includes(status);
