import { Result } from "better-result";

/** Translate typed read failures to TanStack Query's rejected-promise contract. */
export const readQueryResult = <TData, TError extends Error>(
  result: Result<TData, TError>,
): TData => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};
