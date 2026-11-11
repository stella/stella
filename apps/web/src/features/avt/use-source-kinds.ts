/**
 * What each document is to a list's facts (a record or a person's account),
 * read for the documents a view shows and set one document at a time. The
 * server answers every document it is asked about, so this file never
 * assumes a default.
 */

import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import { avtKeys } from "@/features/avt/queries";
import type { SourceKind } from "@/features/avt/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";

const sourceDocumentsApi = (workspaceId: string) =>
  api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) })[
    "source-documents"
  ];

/** Documents per kind read, the endpoint's cap. */
const KIND_READ_CHUNK = 200;

type ListScope = {
  workspaceId: string;
  listId: string;
};

type SourceKindsKey = ListScope & { documentIds: readonly string[] };

const sourceKindKeys = {
  list: ({ workspaceId, listId }: ListScope) =>
    [...avtKeys.all(workspaceId), "source-kinds", listId] as const,
  documents: ({ documentIds, ...scope }: SourceKindsKey) =>
    [...sourceKindKeys.list(scope), documentIds.toSorted()] as const,
};

/** The kind of each named document on the list, keyed by document id. */
export const sourceKindsOptions = (key: SourceKindsKey) =>
  queryOptions({
    queryKey: sourceKindKeys.documents(key),
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        chunkItems(key.documentIds, KIND_READ_CHUNK).map(async (documentIds) =>
          unwrapApiResponse(
            await sourceDocumentsApi(key.workspaceId).kinds.post(
              {
                listId: toSafeId<"legalList">(key.listId),
                documentEntityIds: documentIds.map((id) =>
                  toSafeId<"entity">(id),
                ),
              },
              { fetch: { signal } },
            ),
          ),
        ),
      );
      return new Map<string, SourceKind>(
        pages
          .flatMap((page) => page.documents)
          .map((document) => [document.documentEntityId, document.sourceKind]),
      );
    },
    enabled: key.documentIds.length > 0,
  });

/** A document's kind from a read that was asked about it. */
export const sourceKindOf = (
  kinds: ReadonlyMap<string, SourceKind>,
  documentId: string,
): SourceKind =>
  kinds.get(documentId) ??
  panic("A document's kind was not read with the documents it was shown with");

type SetKindVariables = { documentId: string; sourceKind: SourceKind };

/**
 * Set one document's kind. A switch shows the kind being set while the
 * request is in flight (the mutation's variables); every fact citing the document
 * changes tier, so the list's facts and any open verification are read again
 * once the server has it.
 */
export const useSetSourceKind = (scope: ListScope) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const listKey = sourceKindKeys.list(scope);

  return useMutation({
    mutationKey: [...listKey, "set"],
    mutationFn: async ({ documentId, sourceKind }: SetKindVariables) =>
      unwrapApiResponse(
        await sourceDocumentsApi(scope.workspaceId).put({
          listId: toSafeId<"legalList">(scope.listId),
          documentEntityId: toSafeId<"entity">(documentId),
          sourceKind,
        }),
      ),
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useSetSourceKind:failure",
        scope: { type: "handler", handlerId: "useSetSourceKind:failure" },
      });
      notifyUserError(error, t("avt.save.failedTitle"));
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: listKey }),
        queryClient.invalidateQueries({
          queryKey: legalListKeys.items(scope.workspaceId, scope.listId),
        }),
        queryClient.invalidateQueries({
          queryKey: avtKeys.runs(scope.workspaceId),
        }),
      ]);
    },
  });
};
