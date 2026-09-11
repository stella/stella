import { useSyncExternalStore } from "react";

import { Result } from "better-result";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

const browserSessionStorage = (): Storage | null =>
  Result.try(() => sessionStorage).unwrapOr(null);

/**
 * The tab's storage after hydration. The server and hydration pass both see
 * null, so public pages never render browser state into their server markup.
 */
export const useSessionStorage = (): Storage | null =>
  useSyncExternalStore(noopSubscribe, browserSessionStorage, () => null);
