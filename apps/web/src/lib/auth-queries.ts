import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { PROFESSIONAL_USE_STATUS } from "@stll/api-contract/professional-use";

import { rootKeys } from "@/lib/auth-query-options";
import { STALE_TIME } from "@/lib/consts";

export { rootKeys, sessionOptions } from "@/lib/auth-query-options";

/**
 * The shell blocks on these two, so their worst case is what a user stares
 * at before anything renders. The QueryClient sets no `retry`, i.e. the
 * TanStack default of 3 attempts with exponential backoff — which would turn
 * one stalled connection into roughly four auth-request budgets plus backoff
 * before `beforeLoad` settles. On the boot path, failing fast into the route
 * error boundary's bounded recovery beats a minute-long pending component.
 * Retries stay on for everything downstream of boot.
 */
const BOOT_QUERY_RETRY = false;

/**
 * Reads the session. `bypassCookieCache` asks the server past its session
 * cookie cache, so a change made in another tab (e.g. the active
 * organization) is visible immediately.
 */
export const fetchSession = async ({
  bypassCookieCache = false,
}: { bypassCookieCache?: boolean } = {}) => {
  const [{ authClient }, { toAuthClientError }] = await Promise.all([
    import("@/lib/auth-client"),
    import("@/lib/errors/auth"),
  ]);
  const result = await authClient.getSession(
    bypassCookieCache ? { query: { disableCookieCache: true } } : undefined,
  );

  if (result.error) {
    throw toAuthClientError(result.error);
  }

  return result.data;
};

export const roleOptions = queryOptions({
  retry: BOOT_QUERY_RETRY,
  queryKey: rootKeys.role,
  queryFn: async () => {
    const [{ authClient }, { toAuthClientError }] = await Promise.all([
      import("@/lib/auth-client"),
      import("@/lib/errors/auth"),
    ]);
    const result = await authClient.organization.getActiveMemberRole();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data.role;
  },
  staleTime: STALE_TIME.FIVE.MINUTES,
});

/** Refreshes authentication queries; the host finishes frame cleanup after unmount. */
export const refreshAuthQueries = async (queryClient: QueryClient) => {
  // Load the reset owner at the call boundary; it reads these query options.
  const { settleAuthTransition } = await import("@/lib/session-cache-guard");
  await Promise.all([
    queryClient.refetchQueries({ queryKey: rootKeys.session, type: "all" }),
    queryClient.refetchQueries({ queryKey: rootKeys.role, type: "all" }),
  ]);
  await settleAuthTransition(queryClient);
  const { signalSessionChange } = await import("@/lib/account/session-signal");
  signalSessionChange();
};

/**
 * Required accounts recheck on focus: another tab may accept.
 * Acceptance is permanent; session-change broadcasts invalidate it explicitly.
 */
export const professionalUseOptions = (userId: string) =>
  queryOptions({
    retry: BOOT_QUERY_RETRY,
    queryKey: ["professional-use", userId],
    queryFn: async ({ signal }) => {
      const [{ api }, { unwrapEden }] = await Promise.all([
        import("@/lib/api"),
        import("@/lib/errors/api"),
      ]);
      return unwrapEden(
        await api.me["professional-use"].get({ fetch: { signal } }),
      );
    },
    staleTime: ({ state }) =>
      state.data?.status === PROFESSIONAL_USE_STATUS.accepted
        ? STALE_TIME.INFINITE
        : 0,
  });
