import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const connectedAppsKeys = {
  all: ["settings", "connections", "connected-apps"] as const,
  list: (userId: string) => [...connectedAppsKeys.all, userId] as const,
};

type ListConnectedAppsFn = (typeof api.me)["oauth-connections"]["get"];

/** The session user's authorized OAuth clients ("connected apps"). */
type ConnectedAppsResponse = NonNullable<
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

// Keyed by the session user; see `sessionsOptions` in
// `apps/web/src/lib/account/queries.ts` for the same shape.
export const connectedAppsOptions = (userId: string) =>
  queryOptions({
    queryKey: connectedAppsKeys.list(userId),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    queryFn: fetchConnectedApps,
  });
