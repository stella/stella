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
import { and, eq, isNotNull } from "drizzle-orm";

import type { FolioAIEditOperation } from "@stll/folio-core/ai-edits";

import type { Transaction } from "@/api/db/root";
import {
  docxSuggestions,
  documentReviewFindings,
  documentReviewRuns,
} from "@/api/db/schema";
import type { DocxSuggestionSeverity } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { basisReferenceWorkspaceIds } from "@/api/lib/document-review/reference-passages";
import {
  DOCUMENT_REVIEW_DECISION,
  DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX,
} from "@/api/lib/document-review/run-contract";
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

export type StageReviewFixSuggestionsArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  /** The reviewed document. Suggestions hang off the entity, as the chat edit
   *  tool's do. */
  entityId: SafeId<"entity">;
  runId: SafeId<"documentReviewRun">;
};

/**
 * Stage one suggestion per undecided finding that carries a fix. Returns how
 * many rows this call actually inserted, which is zero on a replay.
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
}: StageReviewFixSuggestionsArgs): Promise<number> => {
  // A review-origin suggestion restates the reviewed document plus the run's
  // pinned references, which may live in other matters. Those are its data
  // scope, so the row records them the way a chat-origin suggestion records
  // its thread's: reading the run through this transaction is what narrows
  // them to what the writer is itself authorized for. The run's own matter is
  // `workspace_id` and is excluded, exactly as the column's insert check
  // expects.
  const runs = await tx
    .select({ basis: documentReviewRuns.basis })
    .from(documentReviewRuns)
    .where(
      and(
        eq(documentReviewRuns.id, runId),
        eq(documentReviewRuns.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const run = runs.at(0);
  if (run === undefined) {
    // Finalization holds the run row in this same transaction.
    return panic("Staging review fixes for a run that does not exist");
  }
  const sourceDataWorkspaceIds = basisReferenceWorkspaceIds(run.basis).filter(
    (referenceWorkspaceId) => referenceWorkspaceId !== workspaceId,
  );

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
    return 0;
  }

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

  // audit: skip — proposals, not document mutations, exactly as the batch
  // create endpoint treats them. The durable trail is written when a reviewer
  // resolves one (resolvedByUserId / resolvedAt, plus the linked finding).
  const inserted = await tx
    .insert(docxSuggestions)
    .values(rows)
    .onConflictDoNothing({
      target: docxSuggestions.originReviewFindingId,
      where: isNotNull(docxSuggestions.originReviewFindingId),
    })
    .returning({ id: docxSuggestions.id });

  return inserted.length;
};
