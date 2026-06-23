import { queryOptions } from "@tanstack/react-query";

import { toAuthClientError } from "@/lib/errors";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const rootKeys = {
  session: ["session"],
  role: ["role"],
};

export const sessionOptions = queryOptions({
  queryKey: rootKeys.session,
  queryFn: async () => {
    const { authClient } = await import("@/lib/auth");
    const result = await authClient.getSession();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data;
  },
  staleTime: ROUTE_QUERY_STALE_TIME_MS,
});

export const roleOptions = queryOptions({
  queryKey: rootKeys.role,
  queryFn: async () => {
    const { authClient } = await import("@/lib/auth");
    const result = await authClient.organization.getActiveMemberRole();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data.role;
  },
  staleTime: ROUTE_QUERY_STALE_TIME_MS,
});
