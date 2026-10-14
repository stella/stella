import { useMutation, useQueryClient } from "@tanstack/react-query";

import { mapWithConcurrency } from "@stll/concurrency";
import { fetchWithTimeout } from "@stll/fetch";

import { SAMPLE_FACTS, type SampleFact } from "@/features/avt/sample-case.data";
import { sampleFactWrites } from "@/features/avt/sample-case.logic";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { useCreateFileEntities } from "@/lib/workspaces/mutations/use-create-file-entities";
import {
  legalListItemsOptions,
  legalListKeys,
  legalListsOptions,
} from "@/lib/workspaces/queries/legal-lists";

const SAMPLE_LIST_NAME = "Whitfield sample facts";
const SAMPLE_DOCUMENT_NAME = "Whitfield witness statement (sample).docx";
const SAMPLE_DOCUMENT_URL = "/samples/avt/whitfield-witness-statement.docx";
const SAMPLE_DOCUMENT_TIMEOUT_MS = 30_000;
const FACT_WRITE_CONCURRENCY = 4;
// 200 items a page; a sample list past this size is no longer the sample.
const SAMPLE_LIST_MAX_PAGES = 10;
const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Loads the sample case into the matter: the sample fact list with every
 * fact's detail, and the sample witness statement. A repeat run completes
 * whatever a failed one left out instead of duplicating it.
 */
export const useLoadSampleCase = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const user = useAuthenticatedUser();
  const [, createFileEntities] = useCreateFileEntities(workspaceId);
  const scope = { workspaceId: toSafeId<"workspace">(workspaceId) };

  return useMutation({
    mutationKey: ["avt", "sample-case", workspaceId],
    mutationFn: async (): Promise<{
      listId: string;
      documentMissing: boolean;
    }> => {
      const lists = await queryClient.fetchQuery(
        legalListsOptions(workspaceId),
      );
      const existing = lists.items.find(
        (list) => list.name === SAMPLE_LIST_NAME,
      );
      const listId =
        existing?.id ??
        unwrapEden(await api.lists(scope).put({ name: SAMPLE_LIST_NAME })).id;

      // Every page, so a fact past the first one is not created twice.
      const items = (
        await queryClient.fetchInfiniteQuery({
          ...legalListItemsOptions({
            workspaceId,
            listId,
            viewer: {
              userId: user.id,
              organizationId: user.activeOrganizationId,
            },
          }),
          pages: SAMPLE_LIST_MAX_PAGES,
          staleTime: 0,
        })
      ).pages.flatMap((page) => page.items);
      const writes = sampleFactWrites(SAMPLE_FACTS, items);
      const writeDetails = async (fact: SampleFact, itemEntityId: string) =>
        unwrapEden(
          await api.lists(scope)["item-fact-details"].put({
            listId: toSafeId<"legalList">(listId),
            itemEntityId: toSafeId<"entity">(itemEntityId),
            ...fact.details,
          }),
        );
      await mapWithConcurrency({
        items: writes.completeDetails,
        limit: FACT_WRITE_CONCURRENCY,
        operation: async ({ fact, itemEntityId }) =>
          writeDetails(fact, itemEntityId),
      });
      // Each fact's detail needs the item created just before it.
      await mapWithConcurrency({
        items: writes.create,
        limit: FACT_WRITE_CONCURRENCY,
        operation: async (fact) => {
          const created = unwrapEden(
            await api.tasks(scope).put({
              name: fact.statement,
              listId: toSafeId<"legalList">(listId),
              listItemType: "fact",
            }),
          );
          await writeDetails(fact, created.entityId);
        },
      });
      await queryClient.invalidateQueries({
        queryKey: legalListKeys.all(workspaceId),
      });

      const documents = unwrapEden(
        await api.entities(scope)["query-window"].post({
          search: SAMPLE_DOCUMENT_NAME,
          excludedKinds: ["task", "folder"],
          fieldMode: "visible",
          limit: 5,
        }),
      ).items;
      if (!documents.some((entity) => entity.name === SAMPLE_DOCUMENT_NAME)) {
        const response = await fetchWithTimeout(SAMPLE_DOCUMENT_URL, {
          timeoutMs: SAMPLE_DOCUMENT_TIMEOUT_MS,
        });
        if (!response.ok) {
          return { listId, documentMissing: true };
        }
        const file = new File([await response.blob()], SAMPLE_DOCUMENT_NAME, {
          type: DOCX_MIME_TYPE,
        });
        // The upload reports its own progress and errors.
        createFileEntities({ files: [file], parentId: null });
      }
      return { listId, documentMissing: false };
    },
  });
};
