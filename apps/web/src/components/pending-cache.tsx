import { createContext, use, useSyncExternalStore } from "react";
import type { PropsWithChildren } from "react";

import type { QueryClient } from "@tanstack/react-query";

// The app's query cache, where its providers are mounted.
const PendingCacheContext = createContext<QueryClient | null>(null);

const neverChanges = () => () => undefined;

/**
 * The query cache a pending view may look into, or `null` where there is
 * nothing to read yet: outside the app's providers, in the server's cold-load
 * paint and in the client's hydration of that paint. The server holds none of
 * a member's data, so a read there could only make the client's first pass
 * differ from the server's; the view reads the cache on the pass right after.
 *
 * Only for synchronous reads of what the cache already holds (a matter's
 * views, the cached role): never a fetch or a subscription, so the view draws
 * what the page will show without waiting on anything.
 */
export const usePendingCache = (): QueryClient | null => {
  const client = use(PendingCacheContext);
  return useSyncExternalStore(
    neverChanges,
    () => client,
    () => null,
  );
};

/** Marks the subtree where pending views may read the app's query cache. */
export const PendingCacheScope = ({
  children,
  client,
}: PropsWithChildren<{ client: QueryClient }>) => (
  <PendingCacheContext value={client}>{children}</PendingCacheContext>
);
