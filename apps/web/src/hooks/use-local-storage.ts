import { useSyncExternalStore } from "react";

import { Result } from "better-result";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

const browserLocalStorage = (): Storage | null =>
  Result.try(() => localStorage).unwrapOr(null);

/**
 * The browser's storage after hydration, or null where there is none: the
 * server, the hydration pass, and a profile that blocks it outright.
 *
 * The sibling of `useSessionStorage`, and the way a public SSR module reaches
 * persisted state at all: those modules may not name a browser global
 * themselves, so the storage is handed to them instead, and a module that
 * takes it as an argument is also one a test can drive with a fake.
 */
export const useLocalStorage = (): Storage | null =>
  useSyncExternalStore(noopSubscribe, browserLocalStorage, () => null);
