import type { ReactNode } from "react";

import { framePendingView } from "@/routes/-pending-view.logic";
import { MemoryPanelPending } from "@/routes/_protected.settings/-components/account/memory/memory-panel.pending";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

/** The memory page's layout, in both phases: the heading over the panel. */
export const MemoryPageShell = ({ children }: { children: ReactNode }) => (
  <>
    <SettingsPageHeaderPending
      description="memory.pageDescription"
      title="memory.pageTitle"
    />
    {children}
  </>
);

const MemoryPendingView = () => (
  <SettingsPagePending area="account">
    <MemoryPageShell>
      <MemoryPanelPending />
    </MemoryPageShell>
  </SettingsPagePending>
);

export const MemoryPending = framePendingView(MemoryPendingView);
