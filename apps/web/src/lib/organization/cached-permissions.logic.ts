import type { QueryClient } from "@tanstack/react-query";

import { memberHasPermissions } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { roleOptions } from "@/lib/auth-queries";

/**
 * Whether the role the cache already holds grants `permissions`, for a
 * loading view that draws the chrome a role gets without subscribing to the
 * role query. Fails closed like `usePermissions`: no cached role, or one
 * whose last read failed, grants nothing, and a grant that also needs the
 * member's own billing access reads as not granted.
 */
export const cachedRoleGrants = (
  queryClient: QueryClient,
  permissions: PermissionInput,
): boolean => {
  const role = queryClient.getQueryData(roleOptions.queryKey);
  return (
    role !== undefined &&
    queryClient.getQueryState(roleOptions.queryKey)?.error === null &&
    memberHasPermissions({ role, billingAccess: false, permissions })
  );
};
