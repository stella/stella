import type { QueryClient, QueryKey } from "@tanstack/react-query";
import * as v from "valibot";

import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

const pendingCreatedDocumentPersistenceSchema = v.strictObject({
  draftMessageId: v.string(),
  matterId: v.string(),
  output: v.strictObject({
    entityId: v.string(),
    entityRef: v.string(),
    fieldId: v.string(),
    fileName: v.string(),
    href: v.string(),
    matterRef: v.string(),
    mention: v.string(),
    success: v.literal(true),
    workspaceId: v.string(),
  }),
  toolCallId: v.string(),
});

export type PendingCreatedDocumentPersistence = v.InferOutput<
  typeof pendingCreatedDocumentPersistenceSchema
>;

export const pendingCreatedDocumentPersistenceKey = (
  conversationId: string,
  toolCallId: string,
): string =>
  `stella:chat:pending-created-document:${conversationId}:${toolCallId}`;

export const readPendingCreatedDocumentPersistence = (
  storage: Storage,
  key: string,
): PendingCreatedDocumentPersistence | null =>
  readStoredJson(storage.getItem(key), pendingCreatedDocumentPersistenceSchema);

export const writePendingCreatedDocumentPersistence = (
  storage: Storage,
  key: string,
  pending: PendingCreatedDocumentPersistence,
): void => {
  writeStoredJson(storage, key, pending);
};

export const clearPendingCreatedDocumentPersistence = (
  storage: Storage,
  key: string,
): void => {
  try {
    storage.removeItem(key);
  } catch {
    // Session storage is best-effort; a replay remains server-idempotent.
  }
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
