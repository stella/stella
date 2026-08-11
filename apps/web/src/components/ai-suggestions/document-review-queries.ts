import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { documentReviewRunPollInterval } from "@/components/ai-suggestions/document-review-run.logic";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

const DOCUMENT_REVIEW_SOURCE_LIMIT = 20;

// The restore decision only ever looks at the newest runs for one document
// (the active one, else the newest completed one), so the facet never pages
// through a document's whole review history.
const DOCUMENT_REVIEW_RUN_HISTORY_LIMIT = 10;

export const documentReviewSourceKeys = {
  all: (workspaceId: string) =>
    ["document-review-sources", workspaceId] as const,
  search: (workspaceId: string, q: string) =>
    [...documentReviewSourceKeys.all(workspaceId), { q }] as const,
};

/** One document's review history: the target the runs belong to. */
export type DocumentReviewRunTarget = {
  workspaceId: string;
  entityId: string;
  fileFieldId: string;
};

/** One durable run, by id. */
type DocumentReviewRunRef = {
  workspaceId: string;
  runId: string;
};

// Both members take the whole key object the query function reads, so the key
// expression names exactly the value the fetch closes over rather than a
// hand-listed subset of its fields.
export const documentReviewRunKeys = {
  all: (workspaceId: string) => ["document-review-runs", workspaceId] as const,
  history: (target: DocumentReviewRunTarget) =>
    [
      ...documentReviewRunKeys.all(target.workspaceId),
      "history",
      { entityId: target.entityId, fileFieldId: target.fileFieldId },
    ] as const,
  detail: (ref: DocumentReviewRunRef) =>
    [
      ...documentReviewRunKeys.all(ref.workspaceId),
      "detail",
      ref.runId,
    ] as const,
};

export const documentReviewSourcesOptions = ({
  workspaceId,
  q,
}: {
  workspaceId: string;
  q: string;
}) =>
  infiniteQueryOptions({
    queryKey: documentReviewSourceKeys.search(workspaceId, q),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["document-reviews"].sources.get({
          fetch: { signal },
          query: {
            q,
            limit: DOCUMENT_REVIEW_SOURCE_LIMIT,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        });
      return unwrapEden(response);
    },
    initialPageParam: stringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

/**
 * A document's review history, newest first. Exported as a plain call as well
 * as query options: when a create loses the race to an already active run
 * (409), the store reads the history directly to attach to that run.
 */
export const fetchDocumentReviewRuns = async (
  { workspaceId, entityId, fileFieldId }: DocumentReviewRunTarget,
  signal?: AbortSignal,
) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["document-reviews"].runs.get({
        query: {
          entityId: toSafeId<"entity">(entityId),
          fileFieldId: toSafeId<"field">(fileFieldId),
          limit: DOCUMENT_REVIEW_RUN_HISTORY_LIMIT,
        },
        ...(signal === undefined ? {} : { fetch: { signal } }),
      }),
  );

export type DocumentReviewRunPage = Awaited<
  ReturnType<typeof fetchDocumentReviewRuns>
>;
export type DocumentReviewRunSummary = DocumentReviewRunPage["items"][number];
export type DocumentReviewRunStatus = DocumentReviewRunSummary["status"];

export const documentReviewRunsOptions = (target: DocumentReviewRunTarget) =>
  queryOptions({
    queryKey: documentReviewRunKeys.history(target),
    queryFn: async ({ signal }) =>
      await fetchDocumentReviewRuns(target, signal),
    // The facet reads this once per open to decide what to restore; a stale
    // answer would resurrect a run the user has already moved past.
    staleTime: 0,
  });

const fetchDocumentReviewRun = async (
  { workspaceId, runId }: DocumentReviewRunRef,
  signal?: AbortSignal,
) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["document-reviews"].runs({
        runId: toSafeId<"documentReviewRun">(runId),
      })
      .get({ ...(signal === undefined ? {} : { fetch: { signal } }) }),
  );

export type DocumentReviewRunDetail = Awaited<
  ReturnType<typeof fetchDocumentReviewRun>
>;
export type DocumentReviewRunRow = DocumentReviewRunDetail["run"];
export type DocumentReviewFindingRow =
  DocumentReviewRunDetail["findings"][number];

export const documentReviewRunOptions = (ref: DocumentReviewRunRef) =>
  queryOptions({
    queryKey: documentReviewRunKeys.detail(ref),
    queryFn: async ({ signal }) => await fetchDocumentReviewRun(ref, signal),
    staleTime: 0,
    // Progress and findings arrive while the worker executes; polling stops on
    // the first terminal status the run reports.
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      if (run === undefined) {
        return false;
      }
      return documentReviewRunPollInterval(run.status);
    },
  });
