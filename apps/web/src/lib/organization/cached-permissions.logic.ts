import type { QueryClient } from "@tanstack/react-query";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import type { OrganizationRoleName } from "@stll/auth-model";
import { memberHasPermissions } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { newestCachedData } from "@/components/pending-cache-reads.logic";
import { rootKeys } from "@/lib/account/auth-query-keys.logic";
import { callerFeatureEnabled } from "@/lib/organization/feature-access/access.logic";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { organizationSettingsQueryRoot } from "@/lib/resource-query-roots.logic";
import type { OrganizationSettings } from "@/queries/organization-settings";

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

/**
 * Whether the organization settings the cache already holds admit a caller
 * feature (named as `CALLER_FEATURE` names it),
 * for a loading view that draws a feature's section without subscribing to
 * the settings read. Fails closed like `useCallerFeatureEnabled`: settings
 * not in the cache, or whose last read failed, admit nothing.
 */
export const cachedCallerFeatureEnabled = (
  queryClient: QueryClient,
  feature: keyof typeof CALLER_FEATURE,
): boolean =>
  callerFeatureEnabled(
    newestCachedData(
      queryClient,
      queryClient.getQueriesData<OrganizationSettings>({
        queryKey: organizationSettingsQueryRoot(),
      }),
    ),
    CALLER_FEATURE[feature],
  );
