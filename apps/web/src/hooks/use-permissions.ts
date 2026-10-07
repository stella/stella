import { useQuery } from "@tanstack/react-query";

import type { PermissionInput } from "@stll/permissions";

import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";

/**
 * Returns whether the active member's role grants the requested
 * permissions. Fails closed: a missing/loading role yields `false`
 * so chrome cannot accidentally expose destructive actions before
 * the role cache hydrates.
 */
export const usePermissions = (permissions: PermissionInput): boolean => {
  const roleView = useQueryView(useQuery(roleOptions));
  useQueryViewError(roleView);

  if (roleView.type !== "items" || roleView.refetchError !== undefined) {
    return false;
  }

  return authClient.organization.checkRolePermission({
    role: roleView.items,
    permissions,
  });
};
