import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  CREATE_DOCUMENT_DRAFT_VIEW,
  createDocumentDraftTabId,
  isCreateDocumentDraftPayload,
  persistCreateDocumentDraftPayload,
} from "@/components/chat/create-document-draft.logic";
import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";

type PromoteCreateDocumentDraftInspectorTabOptions = {
  entityId: string;
  fieldId: string;
  fileName: string;
  inspector: Pick<InspectorTabsStore, "tabs" | "updateView">;
  toolCallId: string;
  workspaceId: string;
};

/** Keep the mounted draft editor and promote only its backing identity. */
export const promoteCreateDocumentDraftInspectorTab = ({
  entityId,
  fieldId,
  fileName,
  inspector,
  toolCallId,
  workspaceId,
}: PromoteCreateDocumentDraftInspectorTabOptions): boolean => {
  const id = createDocumentDraftTabId(toolCallId);
  const tab = inspector.tabs.find((candidate) => candidate.id === id);
  if (
    tab?.type !== "view" ||
    tab.viewType !== CREATE_DOCUMENT_DRAFT_VIEW ||
    !isCreateDocumentDraftPayload(tab.payload)
  ) {
    return false;
  }
  inspector.updateView({
    id,
    label: fileName,
    payload: persistCreateDocumentDraftPayload({
      entityId,
      fieldId,
      fileName,
      payload: tab.payload,
      workspaceId,
    }),
  });
  return true;
};

type InvalidateCreatedDocumentQueriesOptions = {
  queryKeys: readonly QueryKey[];
  queryClient: QueryClient;
};

export const invalidateCreatedDocumentQueries = async ({
  queryKeys,
  queryClient,
}: InvalidateCreatedDocumentQueriesOptions): Promise<void> => {
  await Promise.all(
    queryKeys.map(async (queryKey) => {
      await queryClient.invalidateQueries({ queryKey });
    }),
  );
};
