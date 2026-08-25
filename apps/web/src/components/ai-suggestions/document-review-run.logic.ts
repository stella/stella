/**
 * Pure decisions over a document's durable review runs.
 *
 * The facet holds no run state of its own: when it opens it asks the server
 * what the document's newest runs are and this module decides what that means
 * — attach to the one still executing, restore the newest completed one, or
 * offer the launcher. The same decision answers a create that lost the race to
 * an already active run (409).
 */

import { NEUTRAL_PERSPECTIVE } from "@/components/ai-suggestions/document-review-basis.logic";
import type {
  ReferenceFile,
  ReviewPerspective,
} from "@/components/ai-suggestions/document-review-basis.logic";
import type {
  DecidedReviewFinding,
  DocumentReviewDecision,
  DocumentReviewDecisionCounts,
  DocumentReviewFindingRow,
  DocumentReviewRunDetail,
  DocumentReviewRunRow,
  DocumentReviewRunStatus,
  DocumentReviewRunSummary,
} from "@/components/ai-suggestions/document-review-queries";
import type {
  PlaybookFinding,
  ReferenceFinding,
  ReviewResults,
  ReviewTopic,
} from "@/components/ai-suggestions/playbook-review-store";

/** Poll cadence while a run is still queued or executing. Fast enough that a
 *  short run feels immediate, slow enough that a long one costs little. */
const DOCUMENT_REVIEW_RUN_POLL_INTERVAL_MS = 2500;

/**
 * How often to re-read a run, or `false` once it has settled. Terminal
 * statuses stop the poll: a completed, failed, or cancelled run never changes
 * again, so a further request could only re-fetch the same rows.
 */
export const documentReviewRunPollInterval = (
  status: DocumentReviewRunStatus,
): number | false => {
  switch (status) {
    case "queued":
    case "running":
      return DOCUMENT_REVIEW_RUN_POLL_INTERVAL_MS;
    case "completed":
    case "failed":
    case "cancelled":
      return false;
    default:
      status satisfies never;
      return false;
  }
};

export type ReviewRunRestore =
  | { type: "active"; runId: string }
  | { type: "completed"; runId: string }
  | { type: "failed"; runId: string; errorCode: string | null }
  | { type: "none" };

/** The columns the decision reads, bound to the list endpoint's row so a
 *  renamed or re-typed field fails here rather than at runtime. */
export type ReviewRunHistoryEntry = Pick<
  DocumentReviewRunSummary,
  "id" | "status" | "errorCode"
>;

const isActiveRun = ({ status }: ReviewRunHistoryEntry): boolean =>
  status === "queued" || status === "running";

/**
 * What the facet should show for a document, given its runs newest first.
 *
 * An executing run wins: it is the review the user is waiting on, and at most
 * one can exist per document. Otherwise the newest completed run is the
 * document's current review state (a later failure does not erase it). A
 * document whose only run failed reports that failure so it can be retried;
 * anything else means there is nothing to restore.
 */
export const resolveReviewRunRestore = (
  runs: readonly ReviewRunHistoryEntry[],
): ReviewRunRestore => {
  const active = runs.find(isActiveRun);
  if (active !== undefined) {
    return { type: "active", runId: active.id };
  }
  const completed = runs.find((run) => run.status === "completed");
  if (completed !== undefined) {
    return { type: "completed", runId: completed.id };
  }
  const failed = runs.find((run) => run.status === "failed");
  if (failed !== undefined) {
    return { type: "failed", runId: failed.id, errorCode: failed.errorCode };
  }
  return { type: "none" };
};

/** The run this restore decision tracks, or `null` when there is none. */
export const restoredRunId = (restore: ReviewRunRestore): string | null =>
  restore.type === "none" ? null : restore.runId;

/**
 * The run a rejected create should attach to. The server refuses a second run
 * while one is active, so that active run is the review this request asked
 * for; if it settled in the meantime, its findings are that answer. Anything
 * else means the conflict was not about a run the reviewer can watch, and the
 * caller surfaces the failure instead.
 */
export const resolveRunConflictAttachment = (
  runs: readonly ReviewRunHistoryEntry[],
): string | null => {
  const restore = resolveReviewRunRestore(runs);
  switch (restore.type) {
    case "active":
    case "completed":
      return restore.runId;
    case "failed":
    case "none":
      return null;
    default:
      restore satisfies never;
      return null;
  }
};

/** Which of the facet's three run surfaces a status calls for. */
export type ReviewRunView = "progress" | "results" | "failed";

export const reviewRunView = (
  status: DocumentReviewRunStatus,
): ReviewRunView => {
  switch (status) {
    case "queued":
    case "running":
      return "progress";
    case "completed":
      return "results";
    // A cancelled run produced no verdict either; it is reported and retried
    // exactly like a failure, with no error code to explain.
    case "failed":
    case "cancelled":
      return "failed";
    default:
      status satisfies never;
      return "failed";
  }
};

/**
 * The basis a run was executed against, read back from the run's own pinned
 * snapshot rather than from today's playbook or document names — a completed
 * review must still describe itself after either has moved on.
 */
export type RestoredReviewBasis = {
  playbookId: string | null;
  playbookName: string;
  references: ReferenceFile[];
  /** The side the run's comparison was judged for; `neutral` for a
   *  playbook-only run, which had no comparison. */
  perspective: ReviewPerspective;
};

const pinnedReferenceFiles = (
  references: readonly {
    workspaceId: string;
    workspaceName: string;
    entityId: string;
    fileFieldId: string;
    name: string;
  }[],
): ReferenceFile[] =>
  references.map((reference) => ({
    workspaceId: reference.workspaceId,
    workspaceName: reference.workspaceName,
    entityId: reference.entityId,
    fileFieldId: reference.fileFieldId,
    name: reference.name,
    // A run pins a reference by version, not by file name; the pinned display
    // name is the only name a restored run can honestly show.
    fileName: reference.name,
  }));

export const restoreReviewBasis = (
  basis: DocumentReviewRunDetail["run"]["basis"],
): RestoredReviewBasis => {
  switch (basis.type) {
    case "playbook":
      return {
        playbookId: basis.playbook.definitionId,
        playbookName: basis.playbook.definitionSnapshot.name,
        references: [],
        perspective: NEUTRAL_PERSPECTIVE,
      };
    case "references":
      return {
        playbookId: null,
        playbookName: "",
        references: pinnedReferenceFiles(basis.references),
        perspective: basis.perspective,
      };
    case "combined":
      return {
        playbookId: basis.playbook.definitionId,
        playbookName: basis.playbook.definitionSnapshot.name,
        references: pinnedReferenceFiles(basis.references),
        perspective: basis.perspective,
      };
    default:
      basis satisfies never;
      return {
        playbookId: null,
        playbookName: "",
        references: [],
        perspective: NEUTRAL_PERSPECTIVE,
      };
  }
};

/** What a reviewer decided about one of the run's findings, kept apart from
 *  the engine payload the cards render: the decision belongs to the row, not
 *  to the judgment the model produced. */
export type ReviewFindingDecisionRow = Pick<
  DocumentReviewFindingRow,
  "id" | "topicId" | "checkKind" | "decision" | "applicationStatus"
>;

export type RestoredReviewRun = {
  basis: RestoredReviewBasis;
  topics: ReviewTopic[];
  results: ReviewResults;
  decisions: ReviewFindingDecisionRow[];
};

/**
 * A persisted run rendered as the result join the facet already speaks. The
 * finding payloads are the engine shapes verbatim, so they need no mapping;
 * what this decides is the two states the join distinguishes — a check kind
 * that never ran (`null`) versus one that ran and found nothing (`[]`) — and
 * which confirmed topics actually produced a judgment.
 */
export const restoreReviewRun = ({
  run,
  findings,
}: DocumentReviewRunDetail): RestoredReviewRun => {
  const playbook: PlaybookFinding[] = [];
  const references: ReferenceFinding[] = [];
  const decisions: ReviewFindingDecisionRow[] = [];
  const judgedTopicIds = new Set<string>();
  for (const finding of findings) {
    judgedTopicIds.add(finding.topicId);
    decisions.push({
      id: finding.id,
      topicId: finding.topicId,
      checkKind: finding.checkKind,
      decision: finding.decision,
      applicationStatus: finding.applicationStatus,
    });
    switch (finding.payload.checkKind) {
      case "playbook":
        playbook.push(finding.payload.finding);
        break;
      case "reference":
        references.push(finding.payload.finding);
        break;
      default:
        finding.payload satisfies never;
        break;
    }
  }

  const basis = restoreReviewBasis(run.basis);
  const ranPlaybookCheck = basis.playbookId !== null;
  const ranReferenceCheck = basis.references.length > 0;

  return {
    basis,
    // Only topics the run actually judged: a confirmed topic whose position
    // carries no answerable question is planned out of the run server-side,
    // and a topic with no result at all is what the join treats as drift.
    topics: run.topics.filter(
      (topic) => topic.included && judgedTopicIds.has(topic.topicId),
    ),
    results: {
      playbook: ranPlaybookCheck ? playbook : null,
      references: ranReferenceCheck ? references : null,
    },
    decisions,
  };
};

/**
 * Whether a decision settles a finding. Total over the vocabulary, so a new
 * disposition cannot land without stating whether it still needs a reviewer —
 * and the counting below, written out per member for the same reason, fails
 * typecheck in the same file.
 */
const DECISION_SETTLES = {
  open: false,
  accepted: true,
  dismissed: true,
} as const satisfies Record<DocumentReviewDecision, boolean>;

export const isDecisionSettled = (decision: DocumentReviewDecision): boolean =>
  DECISION_SETTLES[decision];

export type ReviewDecisionProgress = { decided: number; total: number };

/** How far the reviewer has worked through a run's findings. */
export const reviewDecisionProgress = ({
  open,
  accepted,
  dismissed,
}: DocumentReviewDecisionCounts): ReviewDecisionProgress => ({
  decided: accepted + dismissed,
  total: open + accepted + dismissed,
});

/** Tally the findings a cached run holds. The counts are a fact about those
 *  rows, so they are recounted from them rather than patched in step. */
const tallyReviewDecisions = (
  findings: readonly { decision: DocumentReviewDecision }[],
): DocumentReviewDecisionCounts => {
  const counts: DocumentReviewDecisionCounts = {
    open: 0,
    accepted: 0,
    dismissed: 0,
  };
  for (const { decision } of findings) {
    counts[decision] += 1;
  }
  return counts;
};

/**
 * Fold recorded decisions back into the cached run detail.
 *
 * The endpoint answers with the row it wrote, so the cache is updated from
 * that answer instead of being refetched: a decision changes one field on one
 * finding, and re-reading the whole run per click would poll the findings back
 * for nothing. The counts are recomputed from the updated rows so the header
 * cannot disagree with the cards below it.
 */
export const applyFindingDecisions = (
  detail: DocumentReviewRunDetail | undefined,
  decided: readonly DecidedReviewFinding[],
): DocumentReviewRunDetail | undefined => {
  if (detail === undefined) {
    return undefined;
  }
  const decidedById = new Map(decided.map((row) => [row.id, row]));
  const findings = detail.findings.map((finding) => {
    const update = decidedById.get(finding.id);
    // A row that belongs to another run is not this cache entry's business:
    // finding ids are unique, so this only guards a mismatched write.
    if (update === undefined || update.runId !== detail.run.id) {
      return finding;
    }
    return {
      ...finding,
      decision: update.decision,
      decidedBy: update.decidedBy,
      decidedAt: update.decidedAt,
      applicationStatus: update.applicationStatus,
      appliedBy: update.appliedBy,
      appliedAt: update.appliedAt,
    };
  });
  return {
    run: { ...detail.run, decisionCounts: tallyReviewDecisions(findings) },
    findings,
  };
};

/** How today's playbook stands against the one the run pinned. */
export type ReviewPlaybookFreshness = "current" | "stale" | "missing";

/** What a completed run has fallen behind, if anything. */
export type ReviewRunFreshness = {
  /** The document has a newer version than the one this run measured. */
  documentChanged: boolean;
  playbook: ReviewPlaybookFreshness;
};

type ResolveReviewRunFreshnessArgs = {
  run: Pick<
    DocumentReviewRunRow,
    "entityVersionId" | "playbookStale" | "playbookMissing"
  >;
  /** The document's current version, or `null` while the client does not know
   *  it yet. */
  currentEntityVersionId: string | null;
};

const playbookFreshness = ({
  playbookStale,
  playbookMissing,
}: Pick<
  DocumentReviewRunRow,
  "playbookStale" | "playbookMissing"
>): ReviewPlaybookFreshness => {
  // A deleted definition is missing, never stale: a run cannot be behind a
  // playbook that no longer exists, and there is nothing left to re-run it
  // against.
  if (playbookMissing) {
    return "missing";
  }
  return playbookStale ? "stale" : "current";
};

/**
 * Document staleness is one equality the client is the only party able to
 * make: the server pinned the version it reviewed, and the reader is what
 * knows which version is on screen now. An unknown current version reports no
 * change rather than a false alarm.
 */
export const resolveReviewRunFreshness = ({
  run,
  currentEntityVersionId,
}: ResolveReviewRunFreshnessArgs): ReviewRunFreshness => ({
  documentChanged:
    currentEntityVersionId !== null &&
    currentEntityVersionId !== run.entityVersionId,
  playbook: playbookFreshness(run),
});
