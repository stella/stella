import { Result } from "better-result";

type RegistryRequestObserver = {
  onRequest: () => void;
  onError: (error: unknown) => void;
};
const observers = new Set<RegistryRequestObserver>();

// Registration is explicit; importing a registry client starts no observer.
export const observeRegistryRequests = (
  observer: RegistryRequestObserver,
): (() => boolean) => {
  observers.add(observer);
  return () => observers.delete(observer);
};

export const notifyRegistryRequest = (): void => {
  for (const observer of observers) {
    const result = Result.try({
      try: observer.onRequest,
      catch: (error: unknown) => error,
    });
    if (Result.isError(result)) {
      // A failing last-resort reporter must not prevent requests or observers.
      Result.try({
        try: () => observer.onError(result.error),
        catch: (error: unknown) => error,
      }).unwrapOr(undefined);
    }
  }
};
