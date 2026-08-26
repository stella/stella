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

/** What the run was measured against, read back from the row's own pin. */
export type DocumentReviewRunBasis = DocumentReviewRunRow["basis"];

/** The engine's judgment for one position, exactly as the run persisted it.
 *  Inferred from the run read rather than restated, so a card cannot drift
 *  from the shape the engine writes. */
export type ReviewFinding = DocumentReviewFindingRow["payload"]["finding"];

export type ReviewVerdict = NonNullable<ReviewFinding["verdict"]>;
export type ReviewSeverity = ReviewFinding["severity"];
export type ReviewCitation = ReviewFinding["citations"][number];

/** What a reviewer decided about one finding, and how many findings sit in
 *  each decision. Both read back from the run itself, so the client cannot
 *  name a disposition the endpoint does not accept. */
export type DocumentReviewDecision = DocumentReviewFindingRow["decision"];
export type DocumentReviewApplicationStatus =
  DocumentReviewFindingRow["applicationStatus"];
export type DocumentReviewDecisionCounts =
  DocumentReviewRunRow["decisionCounts"];

/**
 * The decision vocabulary as named constants. Keyed by the uppercased union,
 * so a decision added on the server fails typecheck here rather than leaving
 * the client with a value it never mentions.
 */
export const REVIEW_DECISION = {
  OPEN: "open",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
} as const satisfies Record<
  Uppercase<DocumentReviewDecision>,
  DocumentReviewDecision
>;

export const REVIEW_APPLICATION_STATUS = {
  PENDING: "pending",
  APPLIED: "applied",
} as const satisfies Record<
  Uppercase<DocumentReviewApplicationStatus>,
  DocumentReviewApplicationStatus
>;

/** A decision the reviewer has actually taken: everything the vocabulary holds
 *  except the state a finding is born in. */
export type DecidedReviewDecision = Exclude<
  DocumentReviewDecision,
  typeof REVIEW_DECISION.OPEN
>;

type DecideReviewFindingArgs = {
  workspaceId: string;
  /** The one finding row behind the card being decided: a run holds exactly
   *  one finding per confirmed position. */
  findingId: DocumentReviewFindingRow["id"];
  decision: DocumentReviewDecision;
};

/** Record one decision against one finding. */
export const decideReviewFinding = async ({
  workspaceId,
  findingId,
  decision,
}: DecideReviewFindingArgs) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["document-reviews"].findings({ findingId })
      .patch({ decision }),
  );

/** One recorded decision as the endpoint answers it. */
export type DecidedReviewFinding = Awaited<
  ReturnType<typeof decideReviewFinding>
>;

export const documentReviewRunOptions = (ref: DocumentReviewRunRef) =>
  queryOptions({
    queryKey: documentReviewRunKeys.detail(ref),
    queryFn: async ({ signal }) => await fetchDocumentReviewRun(ref, signal),
    staleTime: 0,
    // Progress and findings arrive while the worker executes, and this read
    // answers with both — so the poll that advances the progress line is the
    // same one that brings the next batch of findings in.
    //
    // Kept running while the tab is hidden: a reviewer who starts a run and
    // switches away must come back to the findings that landed meanwhile, not
    // to the progress state the run left when the tab lost focus.
    refetchIntervalInBackground: true,
    // Polling stops on the first terminal status the run reports.
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      if (run === undefined) {
        return false;
      }
      return documentReviewRunPollInterval(run.status);
    },
  });

const SAVE_AS_PLAYBOOK_TIMEOUT_MS = 20_000;

type SaveRunAsPlaybookArgs = {
  workspaceId: string;
  runId: string;
  name?: string | undefined;
};

/** Keep the positions a run was executed against as an org playbook. The run
 *  snapshot is the whole input: the endpoint reads it through the caller's own
 *  workspace access and copies it into a draft definition. */
export const saveRunAsPlaybook = async ({
  workspaceId,
  runId,
  name,
}: SaveRunAsPlaybookArgs) =>
  unwrapEden(
    await api.playbooks["from-run"].post(
      {
        workspaceId: toSafeId<"workspace">(workspaceId),
        runId: toSafeId<"documentReviewRun">(runId),
        ...(name === undefined ? {} : { name }),
      },
      { fetch: { signal: AbortSignal.timeout(SAVE_AS_PLAYBOOK_TIMEOUT_MS) } },
    ),
  );
