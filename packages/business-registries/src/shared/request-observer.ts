import { Result } from "better-result";

export type RegistryRequestObservation =
  | { onRequest: () => void; onError: (cause: unknown) => void }
  | "unobserved";

export const observeRegistryRequest = (
  observer: RegistryRequestObservation,
): void => {
  if (observer === "unobserved") {
    return;
  }
  const result = Result.try({
    try: observer.onRequest,
    catch: (cause: unknown) => cause,
  });
  if (Result.isError(result)) {
    // A failing last-resort reporter must not prevent the request.
    Result.try({
      try: () => observer.onError(result.error),
      catch: (cause: unknown) => cause,
    }).unwrapOr(undefined);
  }
};
