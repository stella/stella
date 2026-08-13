import { useSyncExternalStore } from "react";

export const SERVER_I18N_TIME_ZONE = "UTC";

const subscribeToTimeZone = (_onStoreChange: () => void) => () => undefined;

/**
 * The IANA time zone used for date/time formatting. The server has no
 * single user time zone, so it formats in UTC; the client uses the
 * browser's resolved zone. Shared by the use-intl provider (React) and
 * the store-level formatter (non-React utilities) so both agree.
 */
export const resolveAppTimeZone = (): string => {
  if (typeof window === "undefined") {
    return SERVER_I18N_TIME_ZONE;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
};

/** Keeps UTC through hydration, then switches formatters to the browser zone. */
export const useHydrationSafeTimeZone = (): string =>
  useSyncExternalStore(
    subscribeToTimeZone,
    resolveAppTimeZone,
    () => SERVER_I18N_TIME_ZONE,
  );
