import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

const RUN_POLL_INTERVAL_MS = 2000;

type DocumentTranslationPreparationRef = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  entityVersionKey: number | string;
};

export const documentTranslationPreparationKeys = {
  all: (workspaceId: string) =>
    ["document-translation-preparations", workspaceId] as const,
  detail: ({
    workspaceId,
    entityId,
    fieldId,
    entityVersionKey,
  }: DocumentTranslationPreparationRef) =>
    [
      ...documentTranslationPreparationKeys.all(workspaceId),
      entityId,
      fieldId,
      entityVersionKey,
    ] as const,
};

const fetchDocumentTranslationPreparation = async (
  { workspaceId, entityId, fieldId }: DocumentTranslationPreparationRef,
  signal: AbortSignal,
) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["document-translations"].prepare.post(
        {
          entityId: toSafeId<"entity">(entityId),
          fieldId: toSafeId<"field">(fieldId),
        },
        { fetch: { signal } },
      ),
  );

export type DocumentTranslationPreparation = Awaited<
  ReturnType<typeof fetchDocumentTranslationPreparation>
>;

export const documentTranslationPreparationOptions = (
  ref: DocumentTranslationPreparationRef,
) =>
  queryOptions({
    queryKey: documentTranslationPreparationKeys.detail(ref),
    queryFn: async ({ signal }) =>
      await fetchDocumentTranslationPreparation(ref, signal),
    retry: shouldRetryAPIRequest,
    staleTime: Number.POSITIVE_INFINITY,
  });

type DocumentTranslationRunRef = {
  workspaceId: string;
  runId: string;
};

export const documentTranslationRunKeys = {
  all: (workspaceId: string) =>
    ["document-translation-runs", workspaceId] as const,
  detail: ({ workspaceId, runId }: DocumentTranslationRunRef) =>
    [...documentTranslationRunKeys.all(workspaceId), "detail", runId] as const,
};

const fetchDocumentTranslationRun = async (
  { workspaceId, runId }: DocumentTranslationRunRef,
  signal?: AbortSignal,
) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["document-translations"].runs({
        runId: toSafeId<"documentTranslationRun">(runId),
      })
      .get({ ...(signal === undefined ? {} : { fetch: { signal } }) }),
  );

export type DocumentTranslationRunDetail = Awaited<
  ReturnType<typeof fetchDocumentTranslationRun>
>;
export type DocumentTranslationRun = DocumentTranslationRunDetail["run"];
type DocumentTranslationRunStatus = DocumentTranslationRun["status"];

export const isDocumentTranslationRunActive = (
  status: DocumentTranslationRunStatus,
): boolean => {
  switch (status) {
    case "queued":
    case "preparing":
    case "translating":
    case "assembling":
    case "validating":
      return true;
    case "completed":
    case "failed":
    case "cancelled":
      return false;
    default:
      status satisfies never;
      return false;
  }
};

export const documentTranslationRunOptions = (ref: DocumentTranslationRunRef) =>
  queryOptions({
    queryKey: documentTranslationRunKeys.detail(ref),
    queryFn: async ({ signal }) =>
      await fetchDocumentTranslationRun(ref, signal),
    retry: shouldRetryAPIRequest,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      if (status !== undefined) {
        return runPollInterval(status);
      }
      return query.state.error !== null &&
        shouldRetryAPIRequest(1, query.state.error)
        ? RUN_POLL_INTERVAL_MS
        : false;
    },
  });

/**
 * Mark matter entity projections stale after a translation creates its output.
 * The active source document must not refetch in place: that reloads Folio and
 * every active entity projection while the completion action is being used.
 * Collection views fetch the marked data when they are next shown; realtime
 * invalidation can still refresh them sooner when connected.
 */
export const invalidateDocumentTranslationOutputQueries = async (
  queryClient: QueryClient,
  workspaceId: string,
) =>
  await queryClient.invalidateQueries({
    queryKey: entitiesKeys.all(workspaceId),
    refetchType: "none",
  });

const runPollInterval = (
  status: DocumentTranslationRunStatus,
): number | false =>
  isDocumentTranslationRunActive(status) ? RUN_POLL_INTERVAL_MS : false;
