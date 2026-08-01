import { queryOptions } from "@tanstack/react-query";

import { toAuthClientError } from "@/lib/errors/auth";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export const rootKeys = {
  session: ["session"],
  role: ["role"],
};

/**
 * The shell blocks on these two, so their worst case is what a user stares
 * at before anything renders. The QueryClient sets no `retry`, i.e. the
 * TanStack default of 3 attempts with exponential backoff — which would turn
 * one stalled connection into roughly four auth-request budgets plus backoff
 * before `beforeLoad` settles. On the boot path, failing fast and letting the
 * caller degrade (redirect to `/auth`, or mount chrome without role-gated
 * affordances) beats a minute-long pending component. Retries stay on for
 * everything downstream of boot.
 */
const BOOT_QUERY_RETRY = false;

export const sessionOptions = queryOptions({
  retry: BOOT_QUERY_RETRY,
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
  retry: BOOT_QUERY_RETRY,
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
