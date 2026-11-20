import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { CopyControl } from "@/components/copy-control";
import { usePermissions } from "@/hooks/use-permissions";
import { refreshAuthQueries } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  organizationKeys,
  organizationOptions,
} from "@/lib/organization/queries";
import { OrganizationDangerZone } from "@/routes/_protected.settings/organization/-components/organization-danger-zone";
import { OrganizationDataBoxesCard } from "@/routes/_protected.settings/organization/-components/organization/data-boxes-card";
import { IdentifierPanel } from "@/routes/_protected.settings/organization/-components/organization/identifier-panel.pending";
import { OrganizationJurisdictionsCard } from "@/routes/_protected.settings/organization/-components/organization/jurisdictions-card";
import { OrganizationProfileCard } from "@/routes/_protected.settings/organization/-components/organization/profile-card";
import { OrganizationSlugCard } from "@/routes/_protected.settings/organization/-components/organization/slug-card";
import { OrganizationTimeZoneCard } from "@/routes/_protected.settings/organization/-components/organization/time-zone-card";

import { OrganizationGeneralPageShell } from "./-organization.general.pending";

export function OrganizationGeneralPage() {
  const t = useTranslations();
  const router = useRouter();
  const { activeOrganizationId } = useAuthenticatedUser();
  const { data: organization } = useSuspenseQuery(
    organizationOptions(activeOrganizationId),
  );
  const canChangeOrganization = usePermissions({ organization: ["update"] });
  const isOwner = usePermissions({ organization: ["delete"] });
  const refreshOrganization = async () => {
    await router.options.context.queryClient.invalidateQueries({
      queryKey: organizationKeys.root,
    });
  };
  // The danger zone awaits this inside its mutation, so a failure reaches the
  // mutation's error handling rather than floating.
  const leaveOrganization = async () => {
    await refreshAuthQueries(router.options.context.queryClient);
    await router.navigate({ to: "/" });
  };

  return (
    <OrganizationGeneralPageShell
      dangerZone={
        <OrganizationDangerZone
          organizationId={organization.id}
          organizationName={organization.name}
          isOwner={isOwner}
          onSuccess={leaveOrganization}
        />
      }
      dataBoxes={<OrganizationDataBoxesCard />}
      jurisdictions={<OrganizationJurisdictionsCard />}
      organizationId={
        <IdentifierPanel
          action={<CopyControl text={organization.id} variant="outline" />}
          title={t("admin.organizationId")}
          value={organization.id}
        />
      }
      profile={<OrganizationProfileCard />}
      slug={
        <OrganizationSlugCard
          slug={organization.slug}
          canChange={canChangeOrganization}
          onSuccess={refreshOrganization}
        />
      }
      timeZone={<OrganizationTimeZoneCard />}
    />
  );
}
