import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

const RUN_POLL_INTERVAL_MS = 2000;

type PdfAnonymizationRunRef = {
  workspaceId: string;
  runId: string;
};

export const pdfAnonymizationRunKeys = {
  all: (workspaceId: string) =>
    ["pdf-anonymization-runs", workspaceId] as const,
  detail: ({ workspaceId, runId }: PdfAnonymizationRunRef) =>
    [...pdfAnonymizationRunKeys.all(workspaceId), runId] as const,
};

const fetchPdfAnonymizationRun = async (
  { workspaceId, runId }: PdfAnonymizationRunRef,
  signal?: AbortSignal,
) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["pdf-anonymization"].runs({
        runId: toSafeId<"pdfAnonymizationRun">(runId),
      })
      .get({ ...(signal === undefined ? {} : { fetch: { signal } }) }),
  );

export type PdfAnonymizationRunDetail = Awaited<
  ReturnType<typeof fetchPdfAnonymizationRun>
>;
export type PdfAnonymizationRun = PdfAnonymizationRunDetail["run"];

export const isPdfAnonymizationRunActive = (
  status: PdfAnonymizationRun["status"],
): boolean => {
  switch (status) {
    case "queued":
    case "running":
      return true;
    case "completed":
    case "failed":
      return false;
    default:
      status satisfies never;
      return false;
  }
};

export const pdfAnonymizationRunOptions = (ref: PdfAnonymizationRunRef) =>
  queryOptions({
    queryKey: pdfAnonymizationRunKeys.detail(ref),
    queryFn: async ({ signal }) => await fetchPdfAnonymizationRun(ref, signal),
    retry: shouldRetryAPIRequest,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status !== undefined && isPdfAnonymizationRunActive(status)
        ? RUN_POLL_INTERVAL_MS
        : false;
    },
  });

export const invalidatePdfAnonymizationOutputQueries = async (
  queryClient: QueryClient,
  workspaceId: string,
) => {
  await queryClient.invalidateQueries({
    queryKey: entitiesKeys.all(workspaceId),
    refetchType: "active",
  });
};
