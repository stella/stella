import type { ReactNode } from "react";

import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import { TimePolicyCardPending } from "@/routes/_protected.settings/organization/-components/organization/time-policy-card.pending";

/** The time policy page's layout, in both phases: heading, card. */
export const TimePolicyPageShell = ({
  children,
}: {
  /** The time policy card. */
  children: ReactNode;
}) => (
  <>
    <SettingsPageHeaderPending
      description="settings.organization.timePolicy.description"
      title="settings.organization.timePolicy.title"
    />
    {children}
  </>
);

const TimePolicyPendingView = () => (
  <SettingsPagePending area="organization">
    <TimePolicyPageShell>
      <TimePolicyCardPending />
    </TimePolicyPageShell>
  </SettingsPagePending>
);

export const TimePolicyPending = framePendingView(TimePolicyPendingView);
