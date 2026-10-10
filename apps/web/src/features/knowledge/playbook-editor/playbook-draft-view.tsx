import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { PlaybookEditor } from "@/features/knowledge/playbook-editor/playbook-editor";
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
  const { id: tabId } = tab;
  const { playbookId } = tab.payload;

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
