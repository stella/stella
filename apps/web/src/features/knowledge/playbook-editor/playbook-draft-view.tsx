import { useQuery } from "@tanstack/react-query";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { PlaybookEditor } from "@/features/knowledge/playbook-editor/playbook-editor";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { PlaybookDraftViewPayload } from "@/lib/knowledge/playbook-draft-view";
import { playbookDetailOptions } from "@/lib/knowledge/queries";
import { useQueryView } from "@/lib/use-query-view";

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
  const { id: tabId, label: tabLabel } = tab;
  const { playbookId } = tab.payload;
  // The editor reads the same cached query and shows its loading and error
  // states; this read only names the tab.
  const detailView = useQueryView(
    useQuery(playbookDetailOptions(activeOrganizationId, playbookId)),
  );
  const name =
    detailView.type === "items" && "name" in detailView.items
      ? detailView.items.name
      : null;

  // The tab label follows the playbook's saved name.
  useExternalSyncEffect(() => {
    if (name === null || name.trim() === "" || name === tabLabel) {
      return;
    }
    useInspectorTabsStore.getState().updateView({
      id: tabId,
      label: name,
      payload: { type: "playbook", playbookId },
    });
  }, [name, playbookId, tabId, tabLabel]);

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col">
      <PlaybookEditor
        host={{ type: "pane", tabId, isTabOpen, onClose }}
        // A thread that moves on to another playbook gets a fresh form.
        key={playbookId}
        organizationId={activeOrganizationId}
        playbookId={playbookId}
      />
    </div>
  );
};
