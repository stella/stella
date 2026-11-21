import { panic } from "better-result";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { PlaybookEditor } from "@/features/knowledge/playbook-editor/playbook-editor";
import { PlaybookPendingPane } from "@/features/knowledge/playbook-editor/playbook-pending-pane";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { PlaybookDraftViewPayload } from "@/lib/knowledge/playbook-draft-view";

const isTabOpen = (tabId: string) =>
  useInspectorTabsStore.getState().tabs.some((tab) => tab.id === tabId);

/**
 * The playbook a chat is building, open for editing beside the chat. The
 * playbook id resolves inside the active organization, through the same
 * endpoints and permission checks as the Knowledge page.
 */
export const PlaybookDraftView = ({
  tab,
  onClose,
}: InspectorViewRenderProps<PlaybookDraftViewPayload>) => {
  const { activeOrganizationId } = useAuthenticatedUser();
  const { id: tabId, payload } = tab;

  switch (payload.type) {
    case "pending":
      return <PlaybookPendingPane label={tab.label} onClose={onClose} />;
    case "playbook":
      return (
        <div className="bg-background flex min-h-0 flex-1 flex-col">
          <PlaybookEditor
            host={{ type: "pane", tabId, isTabOpen, onClose }}
            // A thread that moves on to another playbook gets a fresh form.
            key={payload.playbookId}
            organizationId={activeOrganizationId}
            playbookId={payload.playbookId}
          />
        </div>
      );
    default:
      payload satisfies never;
      return panic("Unhandled playbook pane payload");
  }
};
