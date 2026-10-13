import type { ReactNode } from "react";

import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  ArrowLeftIcon,
  BuildingIcon,
  ChevronsUpDownIcon,
} from "@stll/ui/icons";
import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { ScrollArea } from "@stll/ui/scroll-area";
import { WorkspaceFrame } from "@stll/workspace-ui/workspace-frame";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarToggleHotkey,
  SidebarTrigger,
} from "@/components/sidebar";
import {
  OrganizationMenuSection,
  SidebarUserMenu,
} from "@/components/sidebar-user-menu";
import { env } from "@/env";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { roleOptions } from "@/lib/auth-queries";
import {
  AuthenticatedUserProvider,
  useAuthenticatedUser,
} from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { organizationListOptions } from "@/lib/organization/queries";
import { usageEntitlementOptions } from "@/lib/usage-queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { isBillingSettingsAccessible } from "@/routes/_protected.settings/-components/organization/billing-settings.logic";

const ADMIN_SECTIONS = [
  {
    label: null,
    items: [{ to: "/admin", label: "workspaces.views.layouts.overview" }],
  },
  {
    label: "common.organization",
    items: [{ to: "/admin/general", label: "admin.general" }],
  },
  {
    label: "admin.people",
    items: [{ to: "/admin/members", label: "common.members" }],
  },
  {
    label: "admin.ai",
    items: [
      { to: "/admin/ai", label: "admin.modelsAndProviders" },
      {
        to: "/admin/anonymization",
        label: "settings.organization.anonymization.title",
      },
      { to: "/admin/tools", label: "knowledge.sections.tools.title" },
    ],
  },
  {
    label: "admin.billingAndUsage",
    items: [{ to: "/admin/usage", label: "admin.planAndUsage" }],
  },
  {
    label: null,
    items: [
      { to: "/admin/audit-logs", label: "settings.organization.auditLogs" },
    ],
  },
  {
    label: "admin.firmSetup",
    items: [
      {
        to: "/admin/matter-numbering",
        label: "settings.organization.matterNumbering",
      },
      {
        to: "/admin/document-types",
        label: "settings.organization.documentTypes.title",
      },
      {
        to: "/admin/time-policy",
        label: "settings.organization.timePolicy.title",
      },
      { to: "/admin/number-series", label: "billing.numberSeries.title" },
      { to: "/admin/vat-rates", label: "billing.vatRates.title" },
      { to: "/admin/billing", label: "admin.billingProfiles" },
      { to: "/admin/catalogue", label: "common.catalogue" },
    ],
  },
] as const;

export const AdminAppFrame = ({
  user,
  children,
}: {
  user: AuthenticatedUser;
  children: ReactNode;
}) => (
  <AuthenticatedUserProvider user={user}>
    <SidebarProvider>
      <SidebarToggleHotkey />
      <WorkspaceFrame
        composition="host-responsive"
        navigation={{ content: <AdminSidebar />, mode: "responsive" }}
        topBar={() => <AdminTopBar />}
      >
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
            {children}
          </main>
        </ScrollArea>
      </WorkspaceFrame>
    </SidebarProvider>
  </AuthenticatedUserProvider>
);

const AdminTopBar = () => {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-2 px-3">
      <SidebarTrigger />
      <span className="text-sm font-medium">{t("admin.title")}</span>
    </div>
  );
};

const AdminSidebar = () => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const roleQuery = useChromeQuery(roleOptions);
  const roleView = useQueryView(roleQuery);
  useQueryViewError(roleView);
  const role =
    roleView.type === "items" && roleView.refetchError === undefined
      ? roleView.items
      : undefined;
  const organizationQuery = useChromeQuery(organizationListOptions(user.id));
  const organizationView = useQueryView(organizationQuery);
  useQueryViewError(organizationView);
  const organization =
    organizationView.type === "items"
      ? organizationView.items.find(
          ({ id }) => id === user.activeOrganizationId,
        )
      : undefined;
  const previewEnabled = useTimeBillingPreviewEnabled();
  const billingAccessible = isBillingSettingsAccessible({
    previewEnabled,
    role,
  });
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const visible = (to: string) => {
    if (to === "/admin/time-policy") {
      return previewEnabled;
    }
    if (
      to === "/admin/number-series" ||
      to === "/admin/vat-rates" ||
      to === "/admin/billing"
    ) {
      return billingAccessible;
    }
    return true;
  };

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link to="/">
                <DirectionalIcon icon={ArrowLeftIcon} />
                <span>{t("admin.backToApp")}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <Menu>
              <MenuTrigger
                render={<SidebarMenuButton />}
                aria-label={t("organization.switchOrganization")}
              >
                <BuildingIcon />
                <BidiText as="span" className="min-w-0 flex-1 truncate">
                  {organization?.name ?? t("common.organization")}
                </BidiText>
                <ChevronsUpDownIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                <OrganizationMenuSection
                  activeOrganizationId={user.activeOrganizationId}
                  role={role}
                  userId={user.id}
                />
              </MenuPopup>
            </Menu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {ADMIN_SECTIONS.map((section) => (
          <SidebarGroup key={section.items[0].to}>
            {section.label && (
              <SidebarGroupLabel>{t(section.label)}</SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items
                  .filter(({ to }) => visible(to))
                  .map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={
                          pathname === item.to || pathname === `${item.to}/`
                        }
                      >
                        <Link to={item.to} activeOptions={{ exact: true }}>
                          <span>{t(item.label)}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <AdminPlan />
        <SidebarMenu>
          <SidebarUserMenu user={user} />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};

const AdminPlan = () => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const query = useChromeQuery(
    usageEntitlementOptions({ organizationId: user.activeOrganizationId }),
  );
  const view = useQueryView(query);
  useQueryViewError(view);
  if (!env.VITE_FEATURE_USAGE) {
    return null;
  }
  const data = view.type === "items" ? view.items : undefined;
  return (
    <div className="text-muted-foreground px-2 text-xs">
      <QueryViewFeedback view={view} />
      {data && (
        <BidiText>
          {data.entitlement ? data.policy.displayName : t("admin.noPlan")}
        </BidiText>
      )}
    </div>
  );
};
