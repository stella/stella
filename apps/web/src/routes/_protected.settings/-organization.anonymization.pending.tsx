import type { ReactNode } from "react";

import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import { AnonymizationDenyListCardPending } from "@/routes/_protected.settings/organization/-components/organization/anonymization-deny-list-card.pending";

/** The anonymization page's layout, in both phases: heading, deny list. */
export const AnonymizationPageShell = ({
  children,
}: {
  /** The deny list card. */
  children: ReactNode;
}) => (
  <>
    <SettingsPageHeaderPending
      description="settings.organization.anonymization.description"
      title="settings.organization.anonymization.title"
    />
    {children}
  </>
);

const AnonymizationPendingView = () => (
  <SettingsPagePending area="organization">
    <AnonymizationPageShell>
      <AnonymizationDenyListCardPending />
    </AnonymizationPageShell>
  </SettingsPagePending>
);

export const AnonymizationPending = framePendingView(AnonymizationPendingView);
