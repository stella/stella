import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { CreateDocumentDraftPersistence } from "@/components/chat/create-document-draft-runtime";
import {
  CREATE_DOCUMENT_DRAFT_VIEW,
  bindCreateDocumentDraftChatThread,
  createDocumentDraftTabId,
  isCreateDocumentDraftPayload,
  persistCreateDocumentDraftPayload,
  setCreateDocumentDraftChatThreadId,
  setCreateDocumentDraftPayloadStatus,
} from "@/components/chat/create-document-draft.logic";
import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

type PromoteCreateDocumentDraftInspectorTabOptions = {
  entityId: string;
  fieldId: string;
  fileName: string;
  getInspector: () => Pick<InspectorTabsStore, "tabs" | "updateView">;
  persistence: Extract<CreateDocumentDraftPersistence, { status: "saving" }>;
  toolCallId: string;
  workspaceId: string;
};

/** Keep the mounted draft editor and promote only its backing identity. */
export const promoteCreateDocumentDraftInspectorTab = ({
  entityId,
  fieldId,
  fileName,
  getInspector,
  persistence,
  toolCallId,
  workspaceId,
}: PromoteCreateDocumentDraftInspectorTabOptions): boolean => {
  const inspector = getInspector();
  const id = createDocumentDraftTabId(toolCallId);
  const tab = inspector.tabs.find((candidate) => candidate.id === id);
  if (
    tab?.type !== "view" ||
    tab.viewType !== CREATE_DOCUMENT_DRAFT_VIEW ||
    !isCreateDocumentDraftPayload(tab.payload)
  ) {
    return false;
  }
  const payload =
    persistence.boundChatThreadId === null
      ? tab.payload
      : bindCreateDocumentDraftChatThread({
          chatThreadId: persistence.boundChatThreadId,
          payload: setCreateDocumentDraftChatThreadId({
            chatThreadId: persistence.boundChatThreadId,
            payload: tab.payload,
          }),
        });
  inspector.updateView({
    id,
    label: fileName,
    payload: persistCreateDocumentDraftPayload({
      entityId,
      fieldId,
      fileName,
      payload,
      workspaceId,
    }),
  });
  return true;
};

type SetCreateDocumentDraftInspectorTabStatusOptions = {
  inspector: Pick<InspectorTabsStore, "tabs" | "updateView">;
  status: "ready" | "saving";
  toolCallId: string;
};

export const setCreateDocumentDraftInspectorTabStatus = ({
  inspector,
  status,
  toolCallId,
}: SetCreateDocumentDraftInspectorTabStatusOptions): boolean => {
  const id = createDocumentDraftTabId(toolCallId);
  const tab = inspector.tabs.find((candidate) => candidate.id === id);
  if (
    tab?.type !== "view" ||
    tab.viewType !== CREATE_DOCUMENT_DRAFT_VIEW ||
    !isCreateDocumentDraftPayload(tab.payload) ||
    tab.payload.status === "persisted"
  ) {
    return false;
  }
  inspector.updateView({
    id,
    label: tab.label,
    payload: setCreateDocumentDraftPayloadStatus({
      payload: tab.payload,
      status,
    }),
  });
  return true;
};

type ResetFailedCreateDocumentDraftInspectorTabOptions = {
  getInspector: () => Pick<InspectorTabsStore, "tabs" | "updateView">;
  toolCallId: string;
};

/** Read the current inspector state at settlement time: a draft can be opened
 * after saving starts, so the tab present at failure is authoritative. */
export const resetFailedCreateDocumentDraftInspectorTab = ({
  getInspector,
  toolCallId,
}: ResetFailedCreateDocumentDraftInspectorTabOptions): boolean =>
  setCreateDocumentDraftInspectorTabStatus({
    inspector: getInspector(),
    status: "ready",
    toolCallId,
  });

type SetCreateDocumentDraftInspectorChatThreadIdOptions = {
  chatThreadId: ChatThreadId;
  inspector: Pick<InspectorTabsStore, "tabs" | "updateView">;
  toolCallId: string;
};

export const setCreateDocumentDraftInspectorChatThreadId = ({
  chatThreadId,
  inspector,
  toolCallId,
}: SetCreateDocumentDraftInspectorChatThreadIdOptions): boolean => {
  const id = createDocumentDraftTabId(toolCallId);
  const tab = inspector.tabs.find((candidate) => candidate.id === id);
  if (
    tab?.type !== "view" ||
    tab.viewType !== CREATE_DOCUMENT_DRAFT_VIEW ||
    !isCreateDocumentDraftPayload(tab.payload) ||
    chatThreadId === tab.payload.originChatThreadId
  ) {
    return false;
  }

  const payload = setCreateDocumentDraftChatThreadId({
    chatThreadId,
    payload: tab.payload,
  });
  if (payload === tab.payload) {
    return true;
  }

  inspector.updateView({ id, label: tab.label, payload });
  return true;
};

type BindCreateDocumentDraftInspectorChatThreadOptions =
  SetCreateDocumentDraftInspectorChatThreadIdOptions;

export const bindCreateDocumentDraftInspectorChatThread = ({
  chatThreadId,
  inspector,
  toolCallId,
}: BindCreateDocumentDraftInspectorChatThreadOptions): boolean => {
  const id = createDocumentDraftTabId(toolCallId);
  const tab = inspector.tabs.find((candidate) => candidate.id === id);
  if (
    tab?.type !== "view" ||
    tab.viewType !== CREATE_DOCUMENT_DRAFT_VIEW ||
    !isCreateDocumentDraftPayload(tab.payload)
  ) {
    return false;
  }

  const payload = bindCreateDocumentDraftChatThread({
    chatThreadId,
    payload: tab.payload,
  });
  if (payload === tab.payload) {
    return payload.chatThreadBinding === "bound";
  }

  inspector.updateView({ id, label: tab.label, payload });
  return true;
};

export const getBoundCreateDocumentDraftInspectorChatThreadId = ({
  inspector,
  toolCallId,
}: Omit<
  SetCreateDocumentDraftInspectorChatThreadIdOptions,
  "chatThreadId"
>): ChatThreadId | null => {
  const tab = inspector.tabs.find(
    (candidate) => candidate.id === createDocumentDraftTabId(toolCallId),
  );
  return tab?.type === "view" &&
    tab.viewType === CREATE_DOCUMENT_DRAFT_VIEW &&
    isCreateDocumentDraftPayload(tab.payload) &&
    tab.payload.chatThreadBinding === "bound"
    ? tab.payload.chatThreadId
    : null;
};

type ResolveBoundCreateDocumentDraftChatThreadIdOptions = Omit<
  SetCreateDocumentDraftInspectorChatThreadIdOptions,
  "chatThreadId"
> & {
  retainedChatThreadId: ChatThreadId | null;
};

/** The tab is a view, not the source of truth: closing it must not discard a
 * server-confirmed draft-chat binding retained by the draft runtime. */
export const resolveBoundCreateDocumentDraftChatThreadId = ({
  inspector,
  retainedChatThreadId,
  toolCallId,
}: ResolveBoundCreateDocumentDraftChatThreadIdOptions): ChatThreadId | null =>
  getBoundCreateDocumentDraftInspectorChatThreadId({ inspector, toolCallId }) ??
  retainedChatThreadId;

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
