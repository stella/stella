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
}: ReconcilePlaybookSaveToolCallsOptions): Promise<void> => {
  if (!consumePlaybookSaveToolCalls({ handledToolCallIds, messages })) {
    return;
  }
  queryClient.removeQueries({
    queryKey: playbookKeys.all(organizationId),
    predicate: (query) =>
      playbookKeys.isDetail(query.queryKey) && !query.isActive(),
  });
  await queryClient.invalidateQueries({
    queryKey: playbookKeys.all(organizationId),
  });
};
