import type { QueryClient } from "@tanstack/react-query";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import type { OrganizationRoleName } from "@stll/auth-model";
import { memberHasPermissions } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { newestCachedData } from "@/components/pending-cache-reads.logic";
import { rootKeys } from "@/lib/account/auth-query-keys.logic";

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
    queryClient.getQueriesData({ exact: true, queryKey: rootKeys.role }),
  );
  return (
    isRoleName(role) &&
    memberHasPermissions({ role, billingAccess: false, permissions })
  );
};
