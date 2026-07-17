import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const connectedAppsKeys = {
  all: ["settings", "connections", "connected-apps"] as const,
};

type ListConnectedAppsFn = (typeof api.me)["oauth-connections"]["get"];

/** The session user's authorized OAuth clients ("connected apps"). */
export type ConnectedAppsResponse = NonNullable<
  Awaited<ReturnType<ListConnectedAppsFn>>["data"]
>;

export type ConnectedApp = ConnectedAppsResponse["connections"][number];

const fetchConnectedApps = async ({
  signal,
}: {
  signal: AbortSignal;
}): Promise<ConnectedAppsResponse> => {
  const response = await api.me["oauth-connections"].get({
    fetch: { signal },
  });
  return unwrapEden(response);
};

// No parameters (the list is always the session user's own), so this stays
// a flat `queryOptions` value rather than a keyed factory — see
// `sessionsOptions` in `_protected.account/-queries.ts` for the same shape.
export const connectedAppsOptions = queryOptions({
  queryKey: connectedAppsKeys.all,
  staleTime: ROUTE_QUERY_STALE_TIME_MS,
  queryFn: fetchConnectedApps,
});
