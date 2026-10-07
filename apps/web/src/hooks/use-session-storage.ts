import { useSyncExternalStore } from "react";

import { browserStorage } from "@/lib/account/browser-storage";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

const browserSessionStorage = (): Storage | null => browserStorage("session");

/**
 * The tab's storage after hydration. The server and hydration pass both see
 * null, so public pages never render browser state into their server markup.
 */
export const useSessionStorage = (): Storage | null =>
  useSyncExternalStore(noopSubscribe, browserSessionStorage, () => null);
