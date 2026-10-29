import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";

import { CopyActionButton } from "@/components/copy-action-button";
import { usePermissions } from "@/hooks/use-permissions";
import { refreshAuthQueries } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { organizationOptions } from "@/lib/organization/queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { OrganizationDangerZone } from "@/routes/_protected.settings/organization/-components/organization-danger-zone";
import { OrganizationJurisdictionsCard } from "@/routes/_protected.settings/organization/-components/organization/jurisdictions-card";
import { OrganizationProfileCard } from "@/routes/_protected.settings/organization/-components/organization/profile-card";
import { OrganizationTimeZoneCard } from "@/routes/_protected.settings/organization/-components/organization/time-zone-card";

export const Route = createFileRoute(
  "/_protected/settings/organization/general",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "admin.general",
      to: "/settings/organization/general",
    }),
  },
  loader: async ({ context }) => {
    await ensureRouteQueryData(
      context.queryClient,
      organizationOptions(context.user.activeOrganizationId),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("admin.general") }] }),
  component: OrganizationGeneralPage,
});

function OrganizationGeneralPage() {
  const t = useTranslations();
  const router = useRouter();
  const { activeOrganizationId } = useAuthenticatedUser();
  const { data: organization } = useSuspenseQuery(
    organizationOptions(activeOrganizationId),
  );
  const isOwner = usePermissions({ organization: ["delete"] });
  // The danger zone awaits this inside its mutation, so a failure reaches the
  // mutation's error handling rather than floating.
  const leaveOrganization = async () => {
    await refreshAuthQueries(router.options.context.queryClient);
    await router.navigate({ to: "/" });
  };

  return (
    <>
      <SettingsPageHeader title={t("admin.general")} />
      <OrganizationProfileCard />
      <Frame>
        <FramePanel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-sm font-medium">
                {t("admin.organizationId")}
              </h2>
              <bdi className="font-mono text-sm break-all">
                {organization.id}
              </bdi>
            </div>
            <CopyActionButton text={organization.id} variant="outline" />
          </div>
        </FramePanel>
      </Frame>
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">
          {t("settings.organization.practiceJurisdictions")}
        </h2>
        <OrganizationJurisdictionsCard />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">
          {t("settings.organization.timeZone.title")}
        </h2>
        <OrganizationTimeZoneCard />
      </section>
      <OrganizationDangerZone
        organizationId={organization.id}
        organizationName={organization.name}
        isOwner={isOwner}
        onSuccess={leaveOrganization}
      />
    </>
  );
}
