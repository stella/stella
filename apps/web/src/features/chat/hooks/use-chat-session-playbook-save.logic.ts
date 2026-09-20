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
  };
  queryClient: QueryClient;
};

/**
 * A chat save runs outside the playbooks page's own mutations, so an open
 * list or editor would otherwise keep showing the playbook as it was. The
 * `all` key prefixes the list, recent, and detail queries alike.
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
  });
};
