import type { PermissionInput } from "@stll/permissions";
import { useSuspenseQuery } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { roleOptions } from "@/routes/-queries";

export const usePermissions = (permissions: PermissionInput): boolean => {
  const { data: role } = useSuspenseQuery(roleOptions);

  return authClient.organization.checkRolePermission({
    role,
    permissions,
  });
};
