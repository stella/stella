import { useQuery } from "@tanstack/react-query";

import { memberHasPermissions } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { activeMemberOptions, roleOptions } from "@/lib/auth-queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/**
 * Returns whether the active member's role grants the requested
 * permissions. Fails closed: a missing/loading role yields `false`
 * so chrome cannot accidentally expose destructive actions before
 * the role cache hydrates.
 */
export const usePermissions = (permissions: PermissionInput): boolean => {
  const roleView = queryView(useQuery(roleOptions));
  useQueryViewError(roleView, "usePermissions:query");

  const needsMemberGrant =
    permissions.billing?.includes("read") === true &&
    roleView.type === "items" &&
    !memberHasPermissions({
      role: roleView.items,
      billingAccess: false,
      permissions,
    });
  const memberView = queryView(
    useQuery({ ...activeMemberOptions, enabled: needsMemberGrant }),
  );
  useQueryViewError(memberView, "usePermissions:member-query");

  if (roleView.type !== "items" || roleView.refetchError !== undefined) {
    return false;
  }

  return memberHasPermissions({
    role: roleView.items,
    billingAccess:
      memberView.type === "items" &&
      memberView.refetchError === undefined &&
      memberView.items.billingAccess,
    permissions,
  });
};
