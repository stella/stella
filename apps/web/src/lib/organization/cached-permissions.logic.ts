import type { QueryClient } from "@tanstack/react-query";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import type { OrganizationRoleName } from "@stll/auth-model";
import { memberHasPermissions } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { newestCachedData } from "@/components/pending-cache-reads.logic";
import { rootKeys } from "@/lib/account/auth-query-keys.logic";
import { callerFeatureEnabled } from "@/lib/organization/feature-access/access.logic";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import type { OrganizationSettings } from "@/queries/organization-settings";
import { organizationSettingsKeys } from "@/queries/organization-settings-keys.logic";

const isRoleName = (value: unknown): value is OrganizationRoleName =>
  ORGANIZATION_ROLE_NAMES.some((name) => name === value);

/**
 * Whether the role the cache already holds grants `permissions`, for a
 * loading view that draws the chrome a role gets without subscribing to the
 * role query. Fails closed like `usePermissions`: no cached role, or one
 * whose last read failed, grants nothing, and a grant that also needs the
 * member's own billing access reads as not granted. It reads the role by its
 * key alone, so a loading view that calls it loads no auth client.
 */
export const cachedRoleGrants = (
  queryClient: QueryClient,
  permissions: PermissionInput,
): boolean => {
  const role = newestCachedData(
    queryClient,
    queryClient.getQueriesData<string>({
      exact: true,
      queryKey: rootKeys.role,
    }),
  );
  return (
    isRoleName(role) &&
    memberHasPermissions({ role, billingAccess: false, permissions })
  );
};

// The cached session's caller (its member and active organization), read
// structurally: the session read is the auth client's, which a loading view
// does not load.
const cachedSessionCaller = (
  queryClient: QueryClient,
): { organizationId: string; userId: string } | undefined => {
  const session: unknown = newestCachedData(
    queryClient,
    queryClient.getQueriesData({
      exact: true,
      queryKey: rootKeys.session,
    }),
  );
  if (
    typeof session !== "object" ||
    session === null ||
    !("user" in session) ||
    !("session" in session)
  ) {
    return undefined;
  }
  const { session: current, user } = session;
  const userId: unknown =
    typeof user === "object" && user !== null && "id" in user
      ? user.id
      : undefined;
  const organizationId: unknown =
    typeof current === "object" &&
    current !== null &&
    "activeOrganizationId" in current
      ? current.activeOrganizationId
      : undefined;
  return typeof userId === "string" && typeof organizationId === "string"
    ? { organizationId, userId }
    : undefined;
};

/**
 * Whether the active organization's settings, as the cache already holds them
 * for the signed-in member, admit a caller feature (named as
 * `CALLER_FEATURE` names it), for a loading view that draws a feature's
 * section without subscribing to the settings read. Another organization's
 * cached settings never count. Fails closed like `useCallerFeatureEnabled`:
 * no cached session, settings not in the cache, or settings whose last read
 * failed admit nothing.
 */
export const cachedCallerFeatureEnabled = (
  queryClient: QueryClient,
  feature: keyof typeof CALLER_FEATURE,
): boolean => {
  const caller = cachedSessionCaller(queryClient);
  if (caller === undefined) {
    return false;
  }
  return callerFeatureEnabled(
    newestCachedData(
      queryClient,
      queryClient.getQueriesData<OrganizationSettings>({
        exact: true,
        queryKey: organizationSettingsKeys.byCaller(caller),
      }),
    ),
    CALLER_FEATURE[feature],
  );
};
