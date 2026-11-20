import type { ReactNode } from "react";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import { DocumentTypesCardPending } from "@/routes/_protected.settings/organization/-components/organization/document-types-card.pending";

export function DocumentTypesShell({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsPageHeader
        description={
          <PendingText
            barClassName="w-96 max-w-full"
            id="settings.organization.documentTypes.description"
          />
        }
        title={
          <PendingText
            barClassName="w-40"
            id="settings.organization.documentTypes.title"
          />
        }
      />
      {children}
    </>
  );
}

export const DocumentTypesPending = framePendingView(() => (
  <SettingsPagePending>
    <DocumentTypesShell>
      <DocumentTypesCardPending />
    </DocumentTypesShell>
  </SettingsPagePending>
));
