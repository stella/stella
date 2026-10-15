import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { mapWithConcurrency } from "@stll/concurrency";
import { fetchWithTimeout } from "@stll/fetch";

import { SAMPLE_FACTS, type SampleFact } from "@/features/avt/sample-case.data";
import {
  isSampleCaseComplete,
  sampleFactWrites,
} from "@/features/avt/sample-case.logic";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";
import { entityCreateLocalInvalidationKeys } from "@/lib/workspaces/mutations/create-file-upload-payload.logic";
import {
  uploadFileEntitiesBatched,
  useBatchUploadLabels,
} from "@/lib/workspaces/mutations/use-create-file-entities";
import { useUpdateView } from "@/lib/workspaces/mutations/views";
import {
  legalListItemsOptions,
  legalListKeys,
  legalListsOptions,
} from "@/lib/workspaces/queries/legal-lists";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import type { AvtWorkspaceView } from "@/lib/workspaces/view-layout";
import { mergeLayout } from "@/lib/workspaces/view-layout";

const SAMPLE_LIST_NAME = "Whitfield sample facts";
const SAMPLE_DOCUMENT_NAME = "Whitfield witness statement (sample).docx";
const SAMPLE_DOCUMENT_URL = "/samples/avt/whitfield-witness-statement.docx";
const SAMPLE_DOCUMENT_IDLE_TIMEOUT_MS = 30_000;
const FACT_WRITE_CONCURRENCY = 4;
// 200 items a page; a sample list past this size is no longer the sample.
const SAMPLE_LIST_MAX_PAGES = 10;
const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type SampleCaseLoad = {
  listId: string;
  /** Some fact or its detail failed to save; a repeat load completes it. */
  factsIncomplete: boolean;
  /** The witness statement could not be fetched or uploaded. */
  documentMissing: boolean;
};

/**
 * Loads the sample case into the matter: the sample fact list with every
 * fact's detail, and the sample witness statement. A repeat run completes
 * whatever a failed one left out instead of duplicating it. Every write
 * settles before the load reports, so a retry never overlaps an earlier run.
 */
export const useLoadSampleCase = ({
  view,
  workspaceId,
}: {
  view: AvtWorkspaceView;
  workspaceId: string;
}) => {
  const submit = useIdempotentSubmit();
  const queryClient = useQueryClient();
  const updateView = useUpdateView(workspaceId);
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const labels = useBatchUploadLabels();
  const scope = { workspaceId: toSafeId<"workspace">(workspaceId) };

  const loadFacts = async (listId: string): Promise<boolean> => {
    // Every page, so a fact past the first one is not created twice.
    const { pages } = await queryClient.infiniteQuery({
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
    });
    // A list past the page cap is not the sample any more: write nothing
    // rather than guess which facts it holds.
    if (pages.at(-1)?.nextCursor) {
      return true;
    }
    const items = pages.flatMap((page) => page.items);
    const writes = sampleFactWrites(SAMPLE_FACTS, items);
    const writeDetails = async (fact: SampleFact, itemEntityId: string) =>
      unwrapEden(
        await api.lists(scope)["item-fact-details"].put({
          listId: toSafeId<"legalList">(listId),
          itemEntityId: toSafeId<"entity">(itemEntityId),
          ...fact.details,
        }),
      );
    const completed = await mapWithConcurrency({
      items: writes.completeDetails,
      limit: FACT_WRITE_CONCURRENCY,
      operation: async ({ fact, itemEntityId }) =>
        await Result.tryPromise(async () => writeDetails(fact, itemEntityId)),
    });
    // Each fact's detail needs the item created just before it.
    const created = await mapWithConcurrency({
      items: writes.create,
      limit: FACT_WRITE_CONCURRENCY,
      operation: async (fact) =>
        await Result.tryPromise(async () => {
          const item = unwrapEden(
            await submit.run({
              operation: `sample.${workspaceId}.${listId}.task`,
              body: {
                name: fact.statement,
                listId: toSafeId<"legalList">(listId),
                listItemType: "fact" as const,
              },
              send: api.tasks(scope).put,
            }),
          );
          await writeDetails(fact, item.entityId);
        }),
    });
    return (
      completed.some((result) => Result.isError(result)) ||
      created.some((result) => Result.isError(result))
    );
  };

  const loadDocument = async (): Promise<boolean> => {
    const documents = unwrapEden(
      await api.entities(scope)["query-window"].post({
        search: SAMPLE_DOCUMENT_NAME,
        excludedKinds: ["task", "folder"],
        fieldMode: "visible",
        limit: 5,
      }),
    ).items;
    if (documents.some((entity) => entity.name === SAMPLE_DOCUMENT_NAME)) {
      return true;
    }
    const response = await fetchWithTimeout(SAMPLE_DOCUMENT_URL, {
      timeout: { type: "idle", ms: SAMPLE_DOCUMENT_IDLE_TIMEOUT_MS },
    });
    if (!response.ok) {
      return false;
    }
    const properties = await queryClient.query(propertiesOptions(workspaceId));
    const propertyId =
      properties.find((property) => property.content.type === "file")?.id ??
      unwrapEden(
        await submit.run({
          operation: `sample.${workspaceId}.property`,
          body: { name: t("common.documents"), contentType: "file" as const },
          send: api.properties({ workspaceId }).put,
        }),
      ).id;
    const uploaded = await uploadFileEntitiesBatched({
      files: [
        new File([await response.blob()], SAMPLE_DOCUMENT_NAME, {
          type: DOCX_MIME_TYPE,
        }),
      ],
      workspaceId,
      propertyId,
      parentId: null,
      labels,
    });
    await Promise.all(
      entityCreateLocalInvalidationKeys(workspaceId).map(
        async (queryKey) => await queryClient.invalidateQueries({ queryKey }),
      ),
    );
    return uploaded.length > 0;
  };

  // The view switch and the notices live here, not in a caller's callbacks:
  // the calling button unmounts as soon as the new list shows up.
  return useMutation({
    mutationKey: ["avt", "sample-case", workspaceId],
    mutationFn: async (): Promise<SampleCaseLoad> => {
      const lists = await queryClient.query(legalListsOptions(workspaceId));
      const existing = lists.items.find(
        (list) => list.name === SAMPLE_LIST_NAME,
      );
      const listId =
        existing?.id ??
        unwrapEden(
          await submit.run({
            operation: `sample.${workspaceId}.list`,
            body: { name: SAMPLE_LIST_NAME },
            send: api.lists(scope).put,
          }),
        ).id;
      const factsIncomplete = await loadFacts(listId);
      const documentLoaded = await loadDocument();
      const load = {
        listId,
        factsIncomplete,
        documentMissing: !documentLoaded,
      };
      // Only a complete load opens the list; otherwise the view keeps
      // offering the load, which completes it.
      if (isSampleCaseComplete(load)) {
        await updateView.mutateAsync({
          viewId: view.id,
          layout: mergeLayout(view.layout, {
            listId: toSafeId<"legalList">(listId),
          }),
        });
      }
      return load;
    },
    // After the load either way, so the view leaves its empty state only
    // once it is over, and a failed load still shows what it saved.
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: legalListKeys.all(workspaceId),
      });
    },
    onSuccess: (load) => {
      if (!isSampleCaseComplete(load)) {
        notifyUserError(null, t("avt.view.loadSampleFailed"));
      }
    },
    onError: (error) => {
      notifyUserError(error, t("avt.view.loadSampleFailed"));
    },
  });
};
