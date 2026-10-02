import { isOrganizationManagementRole } from "@stll/permissions";

import type { Role } from "@/lib/auth-client";

type BillingSettingsAccessOptions = {
  previewEnabled: boolean;
  role: Role | undefined;
};

export const isBillingSettingsAccessible = ({
  previewEnabled,
  role,
}: BillingSettingsAccessOptions): boolean =>
  previewEnabled && role !== undefined && isOrganizationManagementRole(role);
