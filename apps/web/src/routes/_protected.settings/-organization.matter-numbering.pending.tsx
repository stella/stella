import type { ReactNode } from "react";

import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import { MatterNumberingCardPending } from "@/routes/_protected.settings/organization/-components/organization/matter-numbering-card.pending";

/** The matter numbering page's layout, in both phases: heading, card. */
export const MatterNumberingPageShell = ({
  children,
}: {
  /** The matter numbering card. */
  children: ReactNode;
}) => (
  <>
    <SettingsPageHeaderPending
      description="settings.organization.matterNumberingDescription"
      title="settings.organization.matterNumbering"
    />
    {children}
  </>
);

const MatterNumberingPendingView = () => (
  <SettingsPagePending area="organization">
    <MatterNumberingPageShell>
      <MatterNumberingCardPending />
    </MatterNumberingPageShell>
  </SettingsPagePending>
);

export const MatterNumberingPending = framePendingView(
  MatterNumberingPendingView,
);
