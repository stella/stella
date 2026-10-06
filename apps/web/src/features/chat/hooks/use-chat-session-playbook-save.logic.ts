import type { QueryClient } from "@tanstack/react-query";

import {
  consumePlaybookSaveToolCalls,
  type PlaybookSaveMessage,
} from "@/components/chat/chat-ui-tools";

type ReconcilePlaybookSaveToolCallsOptions = {
  handledToolCallIds: Set<string>;
  messages: readonly PlaybookSaveMessage[];
  organizationId: string;
  playbookKeys: {
    all: (organizationId: string) => readonly unknown[];
    isDetail: (queryKey: readonly unknown[]) => boolean;
  };
  queryClient: QueryClient;
};

/**
 * Resolves to the playbook the latest newly handled save wrote, or null.
 *
 * A chat save runs outside the playbooks page's own mutations, so every
 * playbook query is refetched: an open list, and a detail the editor or the
 * inspector is watching. The editor keeps its concurrency token with its
 * draft, so a refetch under an open form costs it a version conflict on the
 * next save, never a silent overwrite of what the chat wrote.
 *
 * A detail nobody is watching is dropped, not invalidated: the editor seeds
 * its form from whatever the cache holds at mount, and an invalidated entry
 * is still served while it refetches.
 */
export const reconcilePlaybookSaveToolCalls = async ({
  handledToolCallIds,
  messages,
  organizationId,
  playbookKeys,
  queryClient,
}: ReconcilePlaybookSaveToolCallsOptions): Promise<string | null> => {
  const latestPlaybookId = consumePlaybookSaveToolCalls({
    handledToolCallIds,
    messages,
  });
  if (latestPlaybookId === null) {
    return null;
  }
  queryClient.removeQueries({
    queryKey: playbookKeys.all(organizationId),
    predicate: (query) =>
      playbookKeys.isDetail(query.queryKey) && !query.isActive(),
  });
  await queryClient.invalidateQueries({
    queryKey: playbookKeys.all(organizationId),
  });
  return latestPlaybookId;
};

/**
 * Whether a chat surface opens the playbook pane by itself. Only a main-area
 * chat does: there the pane opens beside the conversation. In an inspector
 * chat tab or beside a file, the pane would cover the interview the user is
 * answering, so it opens only from the row's "Open playbook".
 */
export type PlaybookPaneMode = "auto-open" | "on-request";

type PlaybookPaneReactionArgs = {
  mode: PlaybookPaneMode;
  /** Below `md` the inspector is a sheet over the whole chat. */
  isMobile: boolean;
  /** The pane was already opened once while this session was mounted. */
  openedThisSession: boolean;
  /** The playbook the thread's pane shows; null while the pane is closed. */
  shownPlaybookId: string | null;
  savedPlaybookId: string;
};

/**
 * What a newly saved playbook does to the thread's pane. An open pane on
 * another playbook moves to the saved one without taking focus; one already
 * showing it is left as it is. A closed pane opens once per mounted session,
 * like a document draft: also on arrival at a thread that already saved one,
 * and never again after the user closed it.
 */
export const playbookPaneReaction = ({
  mode,
  isMobile,
  openedThisSession,
  shownPlaybookId,
  savedPlaybookId,
}: PlaybookPaneReactionArgs): "update" | "open" | "none" => {
  if (shownPlaybookId !== null) {
    return shownPlaybookId === savedPlaybookId ? "none" : "update";
  }
  return mode === "auto-open" && !isMobile && !openedThisSession
    ? "open"
    : "none";
};
