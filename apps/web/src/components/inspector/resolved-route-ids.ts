import { createStore } from "zustand/vanilla";

/**
 * The route ids the router last resolved. The router writes them here and
 * the inspector store reads them when it loads, so the router does not
 * import the inspector store and its code stays out of the entry chunk.
 */
export const resolvedRouteIdsStore = createStore<{
  routeIds: ReadonlySet<string> | null;
}>(() => ({ routeIds: null }));
