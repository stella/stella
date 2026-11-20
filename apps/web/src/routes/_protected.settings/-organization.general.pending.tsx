import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";

import { usePendingCache } from "@/components/pending-cache";
import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import { OrganizationDangerZonePending } from "@/routes/_protected.settings/organization/-components/organization-danger-zone.pending";
import { CopyControlFace } from "@/routes/_protected.settings/organization/-components/organization/copy-control-face.pending";
import { OrganizationDataBoxesCardPending } from "@/routes/_protected.settings/organization/-components/organization/data-boxes-card.pending";
import { IdentifierPanelPending } from "@/routes/_protected.settings/organization/-components/organization/identifier-panel.pending";
import { OrganizationJurisdictionsCardPending } from "@/routes/_protected.settings/organization/-components/organization/jurisdictions-card.pending";
import { OrganizationProfileCardPending } from "@/routes/_protected.settings/organization/-components/organization/profile-card.pending";
import { OrganizationTimeZoneCardPending } from "@/routes/_protected.settings/organization/-components/organization/time-zone-card.pending";

/*
 * The organization's General page, drawn by both phases: the heading, the
 * profile and the slug, then the practice jurisdictions, the time zone and
 * the data boxes under their headings, the id (for support and
 * integrations, so it sits apart from the settings), and the danger zone. The
 * page fills the slots with the live cards; the pending phase with their
 * faces, so each card that loads lands in its own box.
 */

/** One of the page's titled sections: its heading over its card. */
const GeneralSection = ({
  children,
  title,
}: {
  title: PendingTextKey;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-base font-semibold">
      <PendingText barClassName="w-32" id={title} />
    </h2>
    {children}
  </section>
);

type OrganizationGeneralPageShellProps = {
  /** The name and logo card. */
  profile: ReactNode;
  /** The slug's panel. */
  slug: ReactNode;
  /** The organization id's panel. */
  organizationId: ReactNode;
  jurisdictions: ReactNode;
  timeZone: ReactNode;
  dataBoxes: ReactNode;
  dangerZone: ReactNode;
};

/** The General page's layout, in both phases. */
export const OrganizationGeneralPageShell = ({
  dangerZone,
  dataBoxes,
  jurisdictions,
  organizationId,
  profile,
  slug,
  timeZone,
}: OrganizationGeneralPageShellProps) => (
  <>
    <SettingsPageHeaderPending title="admin.general" />
    {profile}
    {slug}
    <GeneralSection title="settings.organization.practiceJurisdictions">
      {jurisdictions}
    </GeneralSection>
    <GeneralSection title="settings.organization.timeZone.title">
      {timeZone}
    </GeneralSection>
    <GeneralSection title="settings.organization.dataBoxes.title">
      {dataBoxes}
    </GeneralSection>
    {organizationId}
    {dangerZone}
  </>
);

const OrganizationGeneralPendingView = () => {
  const queryClient = usePendingCache();
  // Every manager may change the profile, the slug and the settings; only
  // an owner may delete the organization.
  const isOwner =
    queryClient !== null &&
    cachedRoleGrants(queryClient, { organization: ["delete"] });
  return (
    <SettingsPagePending area="organization">
      <OrganizationGeneralPageShell
        dangerZone={<OrganizationDangerZonePending isOwner={isOwner} />}
        dataBoxes={<OrganizationDataBoxesCardPending />}
        jurisdictions={<OrganizationJurisdictionsCardPending />}
        organizationId={
          <IdentifierPanelPending
            action={<CopyControlFace variant="outline" />}
            description="settings.organization.organizationIdHint"
            title="admin.organizationId"
          />
        }
        profile={<OrganizationProfileCardPending />}
        slug={
          <IdentifierPanelPending
            action={
              <ButtonFace size="default" variant="outline">
                <PendingText
                  barClassName="w-24"
                  id="settings.organization.slug.change"
                />
              </ButtonFace>
            }
            description="settings.organization.slug.hint"
            title="settings.organization.slug.title"
          />
        }
        timeZone={<OrganizationTimeZoneCardPending />}
      />
    </SettingsPagePending>
  );
};

export const OrganizationGeneralPending = framePendingView(
  OrganizationGeneralPendingView,
);
