import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import type { DocumentDeletionMessage } from "@/components/chat/chat-ui-tools";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";
import { reconcileDocumentDeletionToolCalls } from "@/features/chat/hooks/use-chat-session-document-deletion.logic";
import { fileMetadataQueryKey } from "@/lib/files/file-metadata-query.logic";
import { workspacesKeys } from "@/lib/workspaces/queries.logic";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";
import { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

const deletionMessages = (
  input: Record<string, string>,
): DocumentDeletionMessage[] => [
  {
    id: "message-1",
    parts: [
      {
        arguments: JSON.stringify(input),
        id: "tool-call-1",
        input,
        name: "delete_document",
        output: { deleted: true },
        state: "complete",
        type: "tool-call",
      },
    ],
    role: "assistant",
  },
];

const tabs = [
  {
    entityId: "entity-1",
    fileName: "Contract.pdf",
    id: "field-1",
    label: "Contract.pdf",
    pdfFileId: null,
    type: "pdf",
    workspaceId: "workspace-tab",
  },
  {
    creationStatus: "ready",
    id: "task-1",
    isNew: false,
    label: "Review contract",
    type: "task",
    workspaceId: "workspace-tab",
  },
] satisfies InspectorTab[];

const seedQuery = (queryClient: QueryClient, queryKey: readonly unknown[]) => {
  queryClient.setQueryData(queryKey, { seeded: true });
};

const isInvalidated = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
) => queryClient.getQueryState(queryKey)?.isInvalidated ?? false;

describe("document deletion cache reconciliation", () => {
  test("invalidates entity roots and overviews for whole-document deletion", async () => {
    const queryClient = new QueryClient();
    const currentEntitiesKey = entitiesKeys.all("workspace-current");
    const currentOverviewKey = workspacesKeys.overview("workspace-current");
    const tabDetailKey = entitiesKeys.detail("workspace-tab", "entity-1");
    const tabOverviewKey = workspacesKeys.overview("workspace-tab");
    const taskDetailKey = taskKeys.detail("workspace-tab", "task-1");
    for (const queryKey of [
      currentEntitiesKey,
      currentOverviewKey,
      tabDetailKey,
      tabOverviewKey,
      taskDetailKey,
    ]) {
      seedQuery(queryClient, queryKey);
    }

    await reconcileDocumentDeletionToolCalls({
      entityKeys: entitiesKeys,
      contextMatterIds: [],
      handledToolCallIds: new Set(),
      messages: deletionMessages({ entity_id: "entity_ref_1" }),
      queryClient,
      tabs,
      workspaceKeys: workspacesKeys,
      workspaceId: "workspace-current",
    });

    expect(isInvalidated(queryClient, currentEntitiesKey)).toBe(true);
    expect(isInvalidated(queryClient, currentOverviewKey)).toBe(true);
    expect(isInvalidated(queryClient, tabDetailKey)).toBe(true);
    expect(isInvalidated(queryClient, tabOverviewKey)).toBe(true);
    expect(isInvalidated(queryClient, taskDetailKey)).toBe(false);
  });

  test("invalidates selected matter and file caches for version deletion", async () => {
    const queryClient = new QueryClient();
    const handledToolCallIds = new Set<string>();
    const entityRootKey = entitiesKeys.all("workspace-tab");
    const detailKey = entitiesKeys.detail("workspace-tab", "entity-1");
    const versionsKey = entitiesKeys.versions("workspace-tab", "entity-1");
    const taskDetailKey = taskKeys.detail("workspace-tab", "task-1");
    const metadataKey = fileMetadataQueryKey({
      fieldId: "field-1",
      workspaceId: "workspace-tab",
    });
    for (const queryKey of [
      entityRootKey,
      detailKey,
      versionsKey,
      taskDetailKey,
      metadataKey,
    ]) {
      seedQuery(queryClient, queryKey);
    }
    const messages = deletionMessages({
      entity_id: "entity_ref_1",
      version_id: "version-1",
    });

    await reconcileDocumentDeletionToolCalls({
      entityKeys: entitiesKeys,
      contextMatterIds: [],
      handledToolCallIds,
      messages,
      queryClient,
      tabs,
      workspaceKeys: workspacesKeys,
      workspaceId: "workspace-tab",
    });

    expect(isInvalidated(queryClient, entityRootKey)).toBe(true);
    expect(isInvalidated(queryClient, detailKey)).toBe(true);
    expect(isInvalidated(queryClient, versionsKey)).toBe(true);
    expect(isInvalidated(queryClient, taskDetailKey)).toBe(false);
    expect(isInvalidated(queryClient, metadataKey)).toBe(true);

    seedQuery(queryClient, detailKey);
    seedQuery(queryClient, versionsKey);
    await reconcileDocumentDeletionToolCalls({
      entityKeys: entitiesKeys,
      contextMatterIds: [],
      handledToolCallIds,
      messages,
      queryClient,
      tabs,
      workspaceKeys: workspacesKeys,
      workspaceId: "workspace-tab",
    });

    expect(isInvalidated(queryClient, detailKey)).toBe(false);
    expect(isInvalidated(queryClient, versionsKey)).toBe(false);
  });

  test("invalidates selected global-chat matter collections", async () => {
    const queryClient = new QueryClient();
    const contextEntitiesKey = entitiesKeys.all("workspace-context");
    seedQuery(queryClient, contextEntitiesKey);

    await reconcileDocumentDeletionToolCalls({
      contextMatterIds: ["workspace-context"],
      entityKeys: entitiesKeys,
      handledToolCallIds: new Set(),
      messages: deletionMessages({
        entity_id: "entity_ref_1",
        version_id: "version-1",
      }),
      queryClient,
      tabs: [],
      workspaceKeys: workspacesKeys,
      workspaceId: undefined,
    });

    expect(isInvalidated(queryClient, contextEntitiesKey)).toBe(true);
  });
});
