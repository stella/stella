import {
  BanknoteIcon,
  BrainIcon,
  BuildingIcon,
  ClockIcon,
  CpuIcon,
  EyeOffIcon,
  FileTextIcon,
  FlaskConicalIcon,
  GaugeIcon,
  HashIcon,
  HistoryIcon,
  LandmarkIcon,
  ListOrderedIcon,
  MonitorIcon,
  PlugIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
} from "@stll/ui/icons";

import type { Role } from "@/lib/auth-client";
import { isBillingSettingsAccessible } from "@/lib/organization/billing-settings.logic";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";

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

// Literal keys keep t() from demanding ICU values a widened
// TranslationKey would require.
const ACCOUNT_SECTION = {
  id: "account",
  labelKey: "settings.account.title",
  items: [
    {
      to: "/settings/account/profile",
      labelKey: "common.profile",
      icon: UserIcon,
    },
    {
      to: "/settings/account/desktop",
      labelKey: "settings.account.desktop",
      icon: MonitorIcon,
    },
    {
      to: "/settings/account/connections",
      labelKey: "settings.connections.title",
      icon: PlugIcon,
    },
    {
      // Personal + firm + matter memory in one panel. RLS scopes what each
      // member sees; firm-library creation is gated inside the panel.
      to: "/settings/account/memory",
      labelKey: "memory.pageTitle",
      icon: BrainIcon,
      gate: "memory",
    },
    {
      to: "/settings/account/beta",
      labelKey: "settings.account.beta",
      icon: FlaskConicalIcon,
      gate: "beta",
    },
  ],
} as const;

const ORGANIZATION_SECTIONS = [
  {
    id: "organization",
    labelKey: "common.organization",
    items: [
      {
        to: "/settings/organization/general",
        labelKey: "admin.general",
        icon: BuildingIcon,
      },
      {
        to: "/settings/organization/members",
        labelKey: "common.members",
        icon: UsersIcon,
      },
      {
        to: "/settings/organization/usage",
        labelKey: "admin.planAndUsage",
        icon: GaugeIcon,
        gate: "usage",
      },
      {
        to: "/settings/organization/audit-logs",
        labelKey: "settings.organization.auditLogs",
        icon: HistoryIcon,
      },
    ],
  },
  {
    id: "ai",
    labelKey: "admin.ai",
    items: [
      {
        to: "/settings/organization/ai",
        labelKey: "admin.modelsAndProviders",
        icon: CpuIcon,
      },
      {
        to: "/settings/organization/anonymization",
        labelKey: "settings.organization.anonymization.title",
        icon: EyeOffIcon,
      },
      {
        to: "/settings/organization/tools",
        labelKey: "knowledge.sections.tools.title",
        icon: WrenchIcon,
      },
    ],
  },
  {
    id: "firm-setup",
    labelKey: "admin.firmSetup",
    items: [
      {
        to: "/settings/organization/matter-numbering",
        labelKey: "settings.organization.matterNumbering",
        icon: HashIcon,
      },
      {
        to: "/settings/organization/document-types",
        labelKey: "settings.organization.documentTypes.title",
        icon: FileTextIcon,
      },
      {
        to: "/settings/organization/time-policy",
        labelKey: "settings.organization.timePolicy.title",
        icon: ClockIcon,
        gate: "timeBilling",
      },
      {
        to: "/settings/organization/number-series",
        labelKey: "billing.numberSeries.title",
        icon: ListOrderedIcon,
        gate: "billing",
      },
      {
        to: "/settings/organization/vat-rates",
        labelKey: "billing.vatRates.title",
        icon: LandmarkIcon,
        gate: "billing",
      },
      {
        to: "/settings/organization/billing",
        labelKey: "admin.billingProfiles",
        icon: BanknoteIcon,
        gate: "billing",
      },
    ],
  },
] as const;

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
