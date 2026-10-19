import type { Role } from "@/lib/auth-client";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";

type BillingSettingsAccessOptions = {
  previewEnabled: boolean;
  role: Role | undefined;
};

export const isBillingSettingsAccessible = ({
  previewEnabled,
  role,
}: BillingSettingsAccessOptions): boolean =>
  previewEnabled && hasOrganizationManagementAccess(role);
