import type { ReactNode } from "react";

import { Skeleton } from "@stll/ui/skeleton";

import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

export const OrganizationSsoPageShell = ({
  children,
}: {
  children: ReactNode;
}) => <div className="space-y-6">{children}</div>;

const OrganizationSsoPendingView = () => (
  <SettingsPagePending area="organization">
    <OrganizationSsoPageShell>
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-44 w-full rounded-xl" />
    </OrganizationSsoPageShell>
  </SettingsPagePending>
);

export const OrganizationSsoPending = framePendingView(
  OrganizationSsoPendingView,
);
