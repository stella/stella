import { Result } from "better-result";

/** Translate typed failures to TanStack Query and SDK rejected-promise contracts. */
export const readQueryResult = <TData, TError extends Error>(
  result: Result<TData, TError>,
): TData => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};
