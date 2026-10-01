import type { Role } from "@/lib/auth-client";
import { managementRoles } from "@/lib/organization/consts";

type BillingSettingsAccessOptions = {
  previewEnabled: boolean;
  role: Role | undefined;
};

export const isBillingSettingsAccessible = ({
  previewEnabled,
  role,
}: BillingSettingsAccessOptions): boolean =>
  previewEnabled && role !== undefined && managementRoles.includes(role);
