import { useSyncExternalStore } from "react";

import {
  BROWSER_EXTENSION_STORE_URL,
  PRODUCTION_STELLA_ORIGINS,
} from "@stll/api-contract/browser-control";

const STORE_EXTENSION_ORIGINS: ReadonlySet<string> = new Set(
  PRODUCTION_STELLA_ORIGINS,
);

const subscribeToOrigin = (_onStoreChange: () => void) => () => undefined;
const getServerStoreUrl = (): null => null;
const getStoreUrl = (): string | null =>
  STORE_EXTENSION_ORIGINS.has(window.location.origin)
    ? BROWSER_EXTENSION_STORE_URL
    : null;

/**
 * The extension's store listing, or `null` where the released extension never
 * connects: self-hosted, staging and local stella need a build trusting their
 * own origin. Keeps server markup through hydration.
 */
export const useBrowserExtensionStoreUrl = (): string | null =>
  useSyncExternalStore(subscribeToOrigin, getStoreUrl, getServerStoreUrl);
