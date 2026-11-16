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

type ExpectedQueryRefusalOptions<TData, TError extends Error> = {
  run: () => Promise<TData>;
  isExpectedRefusal: (error: unknown) => error is TError;
};

/** Handle selected query refusals as data, preserving every other rejected value
 * for the caller's existing failure owner. */
export const queryResultWithExpectedRefusal = async <
  TData,
  TError extends Error,
>({
  run,
  isExpectedRefusal,
}: ExpectedQueryRefusalOptions<TData, TError>): Promise<
  Result<TData, TError>
> => {
  try {
    return Result.ok(await run());
  } catch (error) {
    if (isExpectedRefusal(error)) {
      return Result.err(error);
    }
    throw error;
  }
};
