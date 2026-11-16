import { Result } from "better-result";

import type { ExceptionScope } from "@stll/errors";

import type { ExceptionFingerprintKey } from "@/lib/analytics/exception-fingerprint";
import { getAnalytics } from "@/lib/analytics/provider";

type QueryErrorOwner = {
  fingerprintKey: ExceptionFingerprintKey;
  scope: ExceptionScope;
};

/** The sole query-failure capture boundary; analytics classifies API transports. */
export const captureQueryError = (
  error: Error,
  owner: QueryErrorOwner,
): void => {
  getAnalytics().captureError(error, owner);
};

/** Translate typed failures to TanStack Query and SDK rejected-promise contracts. */
export const readQueryResult = <TData, TError extends Error>(
  result: Result<TData, TError>,
): TData => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};
