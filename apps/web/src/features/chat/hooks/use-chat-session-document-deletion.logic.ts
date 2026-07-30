import type { QueryClient } from "@tanstack/react-query";

import {
  consumeDocumentDeletionToolCalls,
  type DocumentDeletionMessage,
} from "@/components/chat/chat-ui-tools";
import type { InspectorTab } from "@/components/inspector/inspector-store";
import { fileMetadataQueryRoot } from "@/lib/files/file-metadata-query.logic";

type ReconcileDocumentDeletionToolCallsOptions = {
  entityKeys: {
    all: (workspaceId: string) => readonly unknown[];
  };
  handledToolCallIds: Set<string>;
  messages: readonly DocumentDeletionMessage[];
  contextMatterIds: readonly string[];
  queryClient: QueryClient;
  tabs: readonly InspectorTab[];
  workspaceKeys: {
    overview: (workspaceId: string) => readonly unknown[];
  };
  workspaceId: string | undefined;
};

export const reconcileDocumentDeletionToolCalls = async ({
  contextMatterIds,
  entityKeys,
  handledToolCallIds,
  messages,
  queryClient,
  tabs,
  workspaceKeys,
  workspaceId,
}: ReconcileDocumentDeletionToolCallsOptions): Promise<void> => {
  const { hasVersionDeletion, hasWholeDocumentDeletion } =
    consumeDocumentDeletionToolCalls({ handledToolCallIds, messages });
  if (!hasVersionDeletion && !hasWholeDocumentDeletion) {
    return;
  }

  const fileTabs = tabs.filter((tab) => tab.type === "pdf");
  const invalidations: Promise<unknown>[] = [];
  const affectedWorkspaceIds = new Set([
    ...contextMatterIds,
    ...fileTabs.map((tab) => tab.workspaceId),
  ]);
  if (workspaceId !== undefined) {
    affectedWorkspaceIds.add(workspaceId);
  }

  for (const affectedWorkspaceId of affectedWorkspaceIds) {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: entityKeys.all(affectedWorkspaceId),
      }),
    );
  }

  invalidations.push(
    queryClient.invalidateQueries({ queryKey: fileMetadataQueryRoot() }),
  );

  if (hasWholeDocumentDeletion) {
    for (const affectedWorkspaceId of affectedWorkspaceIds) {
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.overview(affectedWorkspaceId),
        }),
      );
    }
  }

  await Promise.all(invalidations);
};
