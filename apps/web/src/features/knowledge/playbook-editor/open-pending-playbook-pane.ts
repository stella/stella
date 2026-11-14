import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import {
  isPlaybookDraftViewPayload,
  PLAYBOOK_DRAFT_VIEW,
  playbookDraftTabId,
} from "@/lib/knowledge/playbook-draft-view";

type OpenPendingPlaybookPaneOptions = {
  inspector: Pick<InspectorTabsStore, "tabs" | "closeTab" | "openView">;
  threadId: string;
  label: string;
};

/**
 * Opens the pane of a chat that is about to build a playbook. Every such chat
 * is a new thread with its own tab, so a pending pane left by an earlier,
 * unused one is closed first: at most one pending pane exists.
 */
export const openPendingPlaybookPane = ({
  inspector,
  threadId,
  label,
}: OpenPendingPlaybookPaneOptions) => {
  for (const tab of inspector.tabs) {
    if (
      tab.type === "view" &&
      tab.viewType === PLAYBOOK_DRAFT_VIEW &&
      isPlaybookDraftViewPayload(tab.payload) &&
      tab.payload.type === "pending"
    ) {
      inspector.closeTab(tab.id);
    }
  }
  inspector.openView({
    type: PLAYBOOK_DRAFT_VIEW,
    id: playbookDraftTabId(threadId),
    label,
    payload: { type: "pending" },
  });
};
