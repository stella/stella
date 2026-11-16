import {
  type QueryClient,
  queryOptions,
  skipToken,
} from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { PROFESSIONAL_USE_STATUS } from "@stll/api-contract/professional-use";
import { memberHasPermissions } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { rootKeys } from "@/lib/auth-query-options";
import { STALE_TIME } from "@/lib/consts";
import type { toAuthClientError } from "@/lib/errors/auth";
import { ensureRouteQueryData } from "@/lib/react-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

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

type AuthClientResult<T> =
  | { data: T; error: null }
  | { data: null; error: Parameters<typeof toAuthClientError>[0] };

/** The data of an auth client call, or its error as an `AuthClientError`. */
const authClientData = async <T>(result: AuthClientResult<T>): Promise<T> => {
  if (result.error) {
    const errors = await import("@/lib/errors/auth");
    throw errors.toAuthClientError(result.error);
  }
  return result.data;
};

/**
 * Reads the session. `bypassCookieCache` asks the server past its session
 * cookie cache, so a change made in another tab (e.g. the active
 * organization) is visible immediately.
 */
export const fetchSession = async ({
  bypassCookieCache = false,
}: { bypassCookieCache?: boolean } = {}) => {
  const { authClient } = await import("@/lib/auth-client");
  return await authClientData(
    await authClient.getSession(
      bypassCookieCache ? { query: { disableCookieCache: true } } : undefined,
    ),
  );
};

export const roleOptions = resourceQueryOptions(
  queryOptions({
    retry: BOOT_QUERY_RETRY,
    queryKey: rootKeys.role,
    queryFn: async () => {
      const { authClient } = await import("@/lib/auth-client");
      const { role } = await authClientData(
        await authClient.organization.getActiveMemberRole(),
      );
      return role;
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  }),
  {
    resources: [RESOURCE_TYPE.USER, RESOURCE_TYPE.ORGANIZATION],
    scope: { type: "organization" },
  },
);

/** The additional membership grant is read only when role grants do not decide the operation. */
export const activeMemberOptions = resourceQueryOptions(
  queryOptions({
    queryKey: ["active-organization-member"],
    retry: BOOT_QUERY_RETRY,
    queryFn: async () => {
      const { authClient } = await import("@/lib/auth-client");
      return await authClientData(
        await authClient.organization.getActiveMember(),
      );
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  }),
  {
    resources: [RESOURCE_TYPE.USER, RESOURCE_TYPE.ORGANIZATION],
    scope: { type: "organization" },
  },
);

type EnsureMemberPermissionOptions = {
  queryClient: QueryClient;
  permissions: PermissionInput;
};
export const ensureMemberPermission = async ({
  queryClient,
  permissions,
}: EnsureMemberPermissionOptions) => {
  const role = await ensureRouteQueryData(queryClient, roleOptions);
  if (memberHasPermissions({ role, billingAccess: false, permissions })) {
    return true;
  }
  if (!permissions.billing?.includes("read")) {
    return false;
  }
  const member = await ensureRouteQueryData(queryClient, activeMemberOptions);
  return memberHasPermissions({
    role: member.role,
    billingAccess: member.billingAccess,
    permissions,
  });
};

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
export const professionalUseOptions = (userId: string | undefined) =>
  queryOptions({
    retry: BOOT_QUERY_RETRY,
    queryKey: ["professional-use", userId],
    queryFn:
      userId === undefined
        ? skipToken
        : async ({ signal }) => {
            const [{ api }, { unwrapApiResponse }] = await Promise.all([
              import("@/lib/api"),
              import("@/lib/errors/api"),
            ]);
            return unwrapApiResponse(
              await api.me["professional-use"].get({ fetch: { signal } }),
            );
          },
    staleTime: ({ state }) =>
      state.data?.status === PROFESSIONAL_USE_STATUS.accepted
        ? STALE_TIME.INFINITE
        : 0,
  });
