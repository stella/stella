import { isRecord } from "@/api/lib/type-guards";

/** The response headers a retry decision reads (`provider-retry-policy.ts`). */
const RETRY_HEADERS = ["retry-after", "retry-after-ms", "x-should-retry"];

type RetryHintEvidence = {
  headers?: Record<string, string>;
  /** The provider's `x-should-retry` verdict. */
  isRetryable?: boolean;
};

/**
 * The retry hints a failed provider response carried: its retry headers,
 * and the provider's own verdict (`x-should-retry`) as `isRetryable`, the
 * fact `providerFailureFacts` keeps. Empty when it carried none.
 */
export const retryHintEvidence = (headers: Headers): RetryHintEvidence => {
  const hints = RETRY_HEADERS.flatMap((name) => {
    const value = headers.get(name);
    return value === null ? [] : [[name, value] as const];
  });
  if (hints.length === 0) {
    return {};
  }
  const verdict = headers.get("x-should-retry");
  return {
    headers: Object.fromEntries(hints),
    ...(verdict === "true" || verdict === "false"
      ? { isRetryable: verdict === "true" }
      : {}),
  };
};

/**
 * Keeps a provider SDK error's retry hints across TanStack's `RUN_ERROR`
 * projection, which forwards an error's `rawEvent` (else its `error` body)
 * and its status, but none of its response headers. The body stays the
 * evidence it was; the hints join it. An error whose response carried no
 * hint is returned as it is.
 */
export const withRetryHintEvidence = <TError extends object>(
  error: TError,
  headers: Headers,
): TError => {
  const hints = retryHintEvidence(headers);
  if (hints.headers === undefined) {
    return error;
  }
  const body: unknown = Reflect.get(error, "error");
  Object.defineProperty(error, "rawEvent", {
    configurable: true,
    value: { ...(isRecord(body) ? body : {}), ...hints },
  });
  return error;
};
