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
 * A chat save runs outside the playbooks page's own mutations, so an open
 * list would otherwise keep showing the playbooks as they were.
 *
 * A detail an editor is watching is deliberately left alone. The editor's form
 * is seeded once at mount, while its concurrency token follows the cached
 * detail: refetching under it would pair a fresh token with stale positions,
 * and its next save, a full replace, would silently drop what the chat wrote.
 * Left stale, that save meets the version conflict instead. A detail nobody is
 * watching is invalidated, so the editor opens on what the chat saved.
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
  await queryClient.invalidateQueries({
    queryKey: playbookKeys.all(organizationId),
    predicate: (query) =>
      !playbookKeys.isDetail(query.queryKey) || !query.isActive(),
  });
};
