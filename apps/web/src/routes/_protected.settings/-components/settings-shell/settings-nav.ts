import type { Role } from "@/lib/auth-client";
import { isBillingSettingsAccessible } from "@/lib/organization/billing-settings.logic";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import {
  ACCOUNT_SECTION,
  ORGANIZATION_SECTIONS,
} from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/** Per-member conditions that hide a navigation item. */
type SettingsNavGate = "memory" | "beta" | "timeBilling" | "billing" | "usage";

export type SettingsNavAccess = {
  role: Role | undefined;
  /** AI memory is on for the organization and the member may chat. */
  memory: boolean;
  /** Beta features may be switched on this host (dev, staging). */
  beta: boolean;
  /** Time and billing is on for the organization. */
  timeBilling: boolean;
  /** Plan and usage is available on this deployment. */
  usage: boolean;
};

// Both phases draw the sections (./settings-shell.pending.tsx); this
// module decides which of them, and which of their rows, a member sees.
type SettingsNavSectionSource =
  typeof ACCOUNT_SECTION | (typeof ORGANIZATION_SECTIONS)[number];
type SettingsNavItem = SettingsNavSectionSource["items"][number];

/**
 * The sections of the one settings area: the member's own account, then,
 * for organization managers, the organization.
 */
export const settingsNavSections = ({
  role,
  memory,
  beta,
  timeBilling,
  usage,
}: SettingsNavAccess) => {
  const open: Record<SettingsNavGate, boolean> = {
    memory,
    beta,
    timeBilling,
    usage,
    billing: isBillingSettingsAccessible({ previewEnabled: timeBilling, role }),
  };
  const sections: readonly SettingsNavSectionSource[] =
    hasOrganizationManagementAccess(role)
      ? [ACCOUNT_SECTION, ...ORGANIZATION_SECTIONS]
      : [ACCOUNT_SECTION];
  return sections.map(({ id, labelKey, items }) => {
    const all: readonly SettingsNavItem[] = items;
    return {
      id,
      labelKey,
      items: all.filter((item) => !("gate" in item) || open[item.gate]),
    };
  });
};
