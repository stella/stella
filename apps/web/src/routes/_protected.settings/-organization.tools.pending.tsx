import type { ReactNode } from "react";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import {
  NativeToolsRowsPending,
  NativeToolsSearchFace,
} from "@/routes/_protected.settings/organization/-components/native-tools-list.pending";

export function ToolsShell({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsPageHeader
        description={
          <PendingText
            barClassName="w-96 max-w-full"
            id="admin.toolsDescription"
          />
        }
        title={
          <PendingText
            barClassName="w-24"
            id="knowledge.sections.tools.title"
          />
        }
      />
      {children}
    </>
  );
}

export const ToolsPending = framePendingView(() => (
  <SettingsPagePending>
    <ToolsShell>
      <NativeToolsSearchFace />
      <NativeToolsRowsPending />
    </ToolsShell>
  </SettingsPagePending>
));
