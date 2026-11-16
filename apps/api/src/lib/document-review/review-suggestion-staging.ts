/**
 * A completed review's fixes, staged as Folio suggestions.
 *
 * A proposed redline is not a second kind of change: it is the same
 * `docx_suggestions` row the chat edit tool writes, and it is accepted through
 * the same panel. Staging happens once, when the run completes, so the review
 * surface and the document surface read one durable list instead of each
 * holding half of it.
 *
 * `origin_review_finding_id` is the whole link. It carries a unique partial
 * index, so re-finalizing a run inserts nothing the first pass already staged,
 * and resolving the suggestion is what resolves the finding.
 */

import { panic } from "better-result";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { FolioAIEditOperation } from "@stll/folio-core/ai-edits";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, docxSuggestions } from "@/api/db/schema";
import type { DocxSuggestionSeverity } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DOCUMENT_REVIEW_DECISION,
  DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX,
} from "@/api/lib/document-review/run-contract";
import {
  DOCX_PENDING_CAPACITY,
  lockDocxSuggestionPendingCapacity,
} from "@/api/lib/docx/suggestion-pending-capacity";
import { validateDocxSuggestionOperations } from "@/api/lib/folio-operation-validation";
import type { GroundedReviewFix } from "@/api/lib/grounded-review-fix";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-positions";

/**
 * How much a position's severity says a staged change matters. Total over
 * `PositionSeverity` by construction, so a new severity cannot reach the
 * suggestion panel without a decision here. `blocker` and `high` share `high`:
 * the suggestion vocabulary is the folio editor's three-step scale, and it does
 * not distinguish them.
 */
const SUGGESTION_SEVERITY_BY_POSITION_SEVERITY = {
  blocker: "high",
  high: "high",
  medium: "medium",
  low: "low",
} as const satisfies Record<PositionSeverity, DocxSuggestionSeverity>;

/** `docx_suggestions.area` is varchar(128); a position's issue may be longer. */
const AREA_MAX_LENGTH = 128;

/**
 * The folio operation a fix is. The mapping is total and mechanical: the fix
 * vocabulary was chosen to be the editor's own op vocabulary precisely so
 * nothing has to be invented here.
 */
const suggestionOperation = (
  fix: GroundedReviewFix,
  id: string,
): FolioAIEditOperation => {
  switch (fix.kind) {
    case "replaceInBlock":
      return {
        id,
        type: "replaceInBlock",
        blockId: fix.blockId,
        find: fix.find,
        replace: fix.replace,
      };
    case "replaceBlock":
      return { id, type: "replaceBlock", blockId: fix.blockId, text: fix.text };
    case "insertAfterBlock":
      return {
        id,
        type: "insertAfterBlock",
        blockId: fix.blockId,
        text: fix.text,
      };
    default:
      fix satisfies never;
      return panic("Unhandled review fix kind");
  }
};

export const REVIEW_FIX_STAGING = {
  stage: "stage",
  withheld: "withheld",
} as const;

/**
 * What the run's data sources allow staging to do. `sourceDataWorkspaceIds` is
 * every other matter the run's reference text came from, never a subset: a
 * fix's text can restate any of them, and the row must stay hidden from anyone
 * who cannot open all of them. When the requester cannot open one, the fixes
 * are withheld.
 */
export type ReviewFixStaging =
  | {
      type: typeof REVIEW_FIX_STAGING.stage;
      sourceDataWorkspaceIds: SafeId<"workspace">[];
    }
  | { type: typeof REVIEW_FIX_STAGING.withheld };

export type StageReviewFixSuggestionsArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  /** The reviewed document. Suggestions hang off the entity, as the chat edit
   *  tool's do. */
  entityId: SafeId<"entity">;
  runId: SafeId<"documentReviewRun">;
  fixStaging: ReviewFixStaging;
};

export type StagedReviewFixSuggestions = {
  /** Rows this call inserted; zero on a replay. */
  staged: number;
  /** New fixes left unstaged because the document is at its pending cap. */
  skippedForPendingLimit: number;
  /** Fixes left unstaged because the requester cannot open a source matter. */
  skippedForUnreadableReference: number;
};

/**
 * Stage one suggestion per undecided finding that carries a fix.
 *
 * Staging holds the document's pending cap like any other writer, but it does
 * not refuse: it runs while a review run completes, and a document crowded
 * with chat suggestions must not fail the review. Fixes past the cap stay
 * unstaged and are reported; the findings themselves are unaffected.
 *
 * Only `open` findings are staged: this runs after decision carry-over, so a
 * finding the reviewer already accepted or dismissed in the previous review of
 * the same document does not come back as a fresh proposal.
 */
export const stageReviewFixSuggestions = async ({
  tx,
  workspaceId,
  entityId,
  runId,
  fixStaging,
}: StageReviewFixSuggestionsArgs): Promise<StagedReviewFixSuggestions> => {
  const findings = await tx
    .select({
      id: documentReviewFindings.id,
      payload: documentReviewFindings.payload,
    })
    .from(documentReviewFindings)
    .where(
      and(
        eq(documentReviewFindings.runId, runId),
        eq(documentReviewFindings.workspaceId, workspaceId),
        eq(documentReviewFindings.decision, DOCUMENT_REVIEW_DECISION.OPEN),
      ),
    )
    .limit(DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX);

  const staged: {
    findingId: SafeId<"documentReviewFinding">;
    severity: PositionSeverity;
    issue: string;
  }[] = [];
  const operations: FolioAIEditOperation[] = [];
  for (const row of findings) {
    const { fix, issue, severity } = row.payload.finding;
    if (fix === null) {
      continue;
    }
    // The op id is the finding id: a replayed staging derives the same op for
    // the same finding, so nothing downstream has to tell two attempts apart.
    operations.push(suggestionOperation(fix, row.id));
    staged.push({ findingId: row.id, issue, severity });
  }
  if (staged.length === 0) {
    return {
      staged: 0,
      skippedForPendingLimit: 0,
      skippedForUnreadableReference: 0,
    };
  }

  switch (fixStaging.type) {
    case REVIEW_FIX_STAGING.withheld:
      return {
        staged: 0,
        skippedForPendingLimit: 0,
        skippedForUnreadableReference: staged.length,
      };
    case REVIEW_FIX_STAGING.stage:
      break;
    default:
      fixStaging satisfies never;
      return panic("Unhandled review fix staging decision");
  }
  const { sourceDataWorkspaceIds } = fixStaging;

  // The engine built these, so a rejection is a bug in the fix derivation, not
  // untrusted input: fail loudly rather than persisting an op no reader of the
  // entity can hydrate.
  const validated =
    validateDocxSuggestionOperations(operations) ??
    panic("A derived review fix is not a valid folio operation");

  const rows = staged.map((item, index) => ({
    id: createSafeId<"docxSuggestion">(),
    workspaceId,
    entityId,
    originThreadId: null,
    originReviewFindingId: item.findingId,
    sourceDataWorkspaceIds,
    opPayload:
      validated[index] ??
      panic("Folio operation validation returned fewer operations than staged"),
    // Never a rationale. The reasoning behind a review finding is internal and
    // its standard is often another client's negotiated deal; a comment on this
    // row can end up in the document, so nothing but a reviewer's own words
    // ever goes here.
    comment: null,
    severity: SUGGESTION_SEVERITY_BY_POSITION_SEVERITY[item.severity],
    area: item.issue.slice(0, AREA_MAX_LENGTH),
    status: "pending" as const,
  }));

  const capacity = await lockDocxSuggestionPendingCapacity({
    tx,
    workspaceId,
    entityId,
  });
  if (capacity.type === DOCX_PENDING_CAPACITY.entityNotFound) {
    // Finalization reviews a document it already holds.
    return panic("Staging review fixes for a document that does not exist");
  }
  // A finding already staged inserts nothing (its unique key converges), so
  // only the fixes that would actually insert need pending room.
  const alreadyStaged = await tx
    .select({ findingId: docxSuggestions.originReviewFindingId })
    .from(docxSuggestions)
    .where(
      and(
        eq(docxSuggestions.workspaceId, workspaceId),
        inArray(
          docxSuggestions.originReviewFindingId,
          rows.map((row) => row.originReviewFindingId),
        ),
      ),
    )
    .limit(rows.length);
  const alreadyStagedIds = new Set(alreadyStaged.map((row) => row.findingId));
  const fresh = rows.filter(
    (row) => !alreadyStagedIds.has(row.originReviewFindingId),
  );
  const insertable = fresh.slice(0, capacity.remaining);
  const skippedForPendingLimit = fresh.length - insertable.length;
  if (insertable.length === 0) {
    return {
      staged: 0,
      skippedForPendingLimit,
      skippedForUnreadableReference: 0,
    };
  }

  // audit: skip — proposals, not document mutations, exactly as the batch
  // create endpoint treats them. The durable trail is written when a reviewer
  // resolves one (resolvedByUserId / resolvedAt, plus the linked finding).
  const inserted = await tx
    .insert(docxSuggestions)
    .values(insertable)
    .onConflictDoNothing({
      target: docxSuggestions.originReviewFindingId,
      where: isNotNull(docxSuggestions.originReviewFindingId),
    })
    .returning({ id: docxSuggestions.id });

  return {
    staged: inserted.length,
    skippedForPendingLimit,
    skippedForUnreadableReference: 0,
  };
};
