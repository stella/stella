import { useQuery } from "@tanstack/react-query";

import type { PermissionInput } from "@stll/permissions";

import { authClient } from "@/lib/auth";
import { roleOptions } from "@/routes/-queries";

/**
 * Returns whether the active member's role grants the requested
 * permissions. Fails closed: a missing/loading role yields `false`
 * so chrome cannot accidentally expose destructive actions before
 * the role cache hydrates.
 */
export const usePermissions = (permissions: PermissionInput): boolean => {
  const { data: role } = useQuery(roleOptions);

  if (role === undefined) {
    return false;
  }

  return authClient.organization.checkRolePermission({
    role,
    permissions,
  });
};
