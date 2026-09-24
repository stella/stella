/**
 * The route ids the router last resolved, relayed to listeners that load
 * later than the router. A module that reacts to navigation subscribes here
 * instead of the router importing it, so its code stays out of the entry.
 */
type ResolvedRouteIdsListener = (routeIds: ReadonlySet<string>) => void;

const listeners = new Set<ResolvedRouteIdsListener>();
let lastResolved: ReadonlySet<string> | undefined;

export const publishResolvedRouteIds = (routeIds: ReadonlySet<string>) => {
  lastResolved = routeIds;
  for (const listener of listeners) {
    listener(routeIds);
  }
};

/** Subscribes, replaying the last resolution when there is one. */
export const subscribeResolvedRouteIds = (
  listener: ResolvedRouteIdsListener,
): (() => void) => {
  listeners.add(listener);
  if (lastResolved !== undefined) {
    listener(lastResolved);
  }
  return () => {
    listeners.delete(listener);
  };
};
