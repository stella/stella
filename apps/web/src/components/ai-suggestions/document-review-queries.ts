import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { ReviewFlag } from "@stll/api-contract";

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

/** One document's sides, keyed by the document rather than by a run: the
 *  answer is a property of the file's current version, and the launcher asks
 *  for it before any run exists. */
export const documentReviewPartiesKeys = {
  all: (workspaceId: string) =>
    ["document-review-parties", workspaceId] as const,
  target: (target: DocumentReviewRunTarget) =>
    [
      ...documentReviewPartiesKeys.all(target.workspaceId),
      { entityId: target.entityId, fileFieldId: target.fileFieldId },
    ] as const,
};

/**
 * Which sides the reviewed document has, so "We act for" can be answered on
 * the launcher instead of after a proposal has already been paid for.
 *
 * The server caches the detection per document version, so a re-run costs
 * nothing; the client keeps the answer for the session because the reviewer
 * moves between the launcher and the results while the document stands still.
 */
const fetchDocumentReviewParties = async (
  { workspaceId, entityId, fileFieldId }: DocumentReviewRunTarget,
  signal: AbortSignal,
) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["document-reviews"].parties.post(
        {
          target: {
            entityId: toSafeId<"entity">(entityId),
            fileFieldId: toSafeId<"field">(fileFieldId),
          },
        },
        { fetch: { signal } },
      ),
  );

export type DocumentReviewPartiesAnswer = Awaited<
  ReturnType<typeof fetchDocumentReviewParties>
>;

export const documentReviewPartiesOptions = (target: DocumentReviewRunTarget) =>
  queryOptions({
    queryKey: documentReviewPartiesKeys.target(target),
    queryFn: async ({ signal }) =>
      await fetchDocumentReviewParties(target, signal),
    // The detection is pinned to a document version; a new version changes the
    // document on screen, which is a navigation, not a refetch.
    staleTime: Number.POSITIVE_INFINITY,
  });

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

type FetchDocumentReviewRunsOptions = {
  /** Answer with the newest run's findings as well. The facet needs both the
   *  history and the run it restores, and the run's id is only known from this
   *  answer — asking for it afterwards is a second sequential round. */
  includeLatest?: boolean;
  signal?: AbortSignal;
};

/**
 * A document's review history, newest first. Exported as a plain call as well
 * as query options: when a create loses the race to an already active run
 * (409), the store reads the history directly to attach to that run — and
 * wants nothing but the run ids, so it leaves `includeLatest` off.
 */
export const fetchDocumentReviewRuns = async (
  { workspaceId, entityId, fileFieldId }: DocumentReviewRunTarget,
  { includeLatest = false, signal }: FetchDocumentReviewRunsOptions = {},
) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["document-reviews"].runs.get({
        query: {
          entityId: toSafeId<"entity">(entityId),
          fileFieldId: toSafeId<"field">(fileFieldId),
          limit: DOCUMENT_REVIEW_RUN_HISTORY_LIMIT,
          includeLatest,
        },
        ...(signal === undefined ? {} : { fetch: { signal } }),
      }),
  );

export type DocumentReviewRunPage = Awaited<
  ReturnType<typeof fetchDocumentReviewRuns>
>;
export type DocumentReviewRunSummary = DocumentReviewRunPage["items"][number];
export type DocumentReviewRunStatus = DocumentReviewRunSummary["status"];

/**
 * The run-detail cache entries a history page can fill on its own: one pair
 * per run the page answered in full, keyed the way `documentReviewRunOptions`
 * reads it.
 *
 * The return type is stated rather than inferred, and that is the point: the
 * second member is the *point read's* type, so a `latest` projection that
 * drifted from `runs/:runId` fails here instead of seeding the cache with a
 * shape the panel cannot read.
 */
export type DocumentReviewRunDetailSeed = readonly [
  ReturnType<typeof documentReviewRunKeys.detail>,
  DocumentReviewRunDetail,
];

export const documentReviewRunDetailSeeds = (
  workspaceId: string,
  page: Pick<DocumentReviewRunPage, "latest">,
): DocumentReviewRunDetailSeed[] => {
  const { latest } = page;
  if (latest === null) {
    return [];
  }
  return [
    [
      documentReviewRunKeys.detail({ workspaceId, runId: latest.run.id }),
      latest,
    ],
  ];
};

export const documentReviewRunsOptions = (target: DocumentReviewRunTarget) =>
  queryOptions({
    queryKey: documentReviewRunKeys.history(target),
    queryFn: async ({ client, signal }) => {
      const page = await fetchDocumentReviewRuns(target, {
        includeLatest: true,
        signal,
      });
      // Fill the detail cache before the page is handed back, so the panel
      // that mounts on this answer finds its run already there. Done here
      // rather than at a call site because the route loader starts this read
      // too, and the seed has to land whoever asked.
      for (const [key, detail] of documentReviewRunDetailSeeds(
        target.workspaceId,
        page,
      )) {
        client.setQueryData(key, detail);
      }
      return page;
    },
    // The facet reads this once per open to decide what to restore; a stale
    // answer would resurrect a run the user has already moved past.
    staleTime: 0,
  });

/** How long a run detail seeded from the history read counts as current. Just
 *  wide enough to cover the mount that consumes it: re-reading the run the
 *  same answer already carried asks the same question twice in one breath.
 *  Progress does not depend on it — the poll below is not gated by staleness. */
const DOCUMENT_REVIEW_RUN_DETAIL_FRESH_MS = 2000;

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
  /** The finding's whole flag set, when this write changes it. Omitted leaves
   *  the flags as they are, so a decision and a flag stay two gestures. */
  flags?: readonly ReviewFlag[];
};

/**
 * Record one reviewer answer against one finding: the disposition, the flags,
 * or both.
 *
 * `decision` is always sent, current value included, because Elysia coerces an
 * absent optional `UnionEnum` to the first member of its vocabulary — which
 * here would silently reopen the finding. The endpoint treats a restated
 * decision as the no-op it is and leaves the decider and the moment alone.
 */
export const decideReviewFinding = async ({
  workspaceId,
  findingId,
  decision,
  flags,
}: DecideReviewFindingArgs) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["document-reviews"].findings({ findingId })
      .patch({ decision, ...(flags !== undefined && { flags: [...flags] }) }),
  );

/** One recorded decision as the endpoint answers it. */
export type DecidedReviewFinding = Awaited<
  ReturnType<typeof decideReviewFinding>
>;

export const documentReviewRunOptions = (ref: DocumentReviewRunRef) =>
  queryOptions({
    queryKey: documentReviewRunKeys.detail(ref),
    queryFn: async ({ signal }) => await fetchDocumentReviewRun(ref, signal),
    staleTime: DOCUMENT_REVIEW_RUN_DETAIL_FRESH_MS,
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
