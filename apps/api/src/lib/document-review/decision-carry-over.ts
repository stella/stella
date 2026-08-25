/**
 * Carry reviewer decisions across re-runs.
 *
 * Re-reviewing a document must not silently discard the reading a lawyer
 * already did. When a new run reaches the same conclusion about the same
 * quoted text as the previous review of that document, the earlier decision
 * still applies and moves onto the new finding; when the conclusion or the
 * evidence changed, the finding stays `open`, because that is the case a
 * reviewer has to look at again.
 *
 * Cost: two statements per completed run, regardless of how many findings it
 * holds. One SELECT reads this run's findings and the previous completed run's
 * findings together (both bounded by the confirmed-topic cap); one UPDATE
 * copies every match by joining the prior rows back through their ids, so no
 * decision, decider, or timestamp is round-tripped through the application.
 */

import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { findingFingerprint } from "@/api/lib/document-review/finding-fingerprint";
import {
  DOCUMENT_REVIEW_DECISION,
  DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX,
} from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewDecision,
  DocumentReviewFindingPayload,
} from "@/api/lib/document-review/run-contract";

/** What matching needs from a finding row, on either side of the comparison. */
export type CarryOverFinding = {
  id: SafeId<"documentReviewFinding">;
  positionId: string;
  outcome: string | null;
  payload: DocumentReviewFindingPayload;
  decision: DocumentReviewDecision;
};

/** One decision to copy: the new finding, and the decided finding it repeats. */
export type CarriedDecision = {
  findingId: SafeId<"documentReviewFinding">;
  priorFindingId: SafeId<"documentReviewFinding">;
};

/** A finding answers one position, which is what makes two findings from
 *  different runs comparable at all. */
const comparisonKey = ({ positionId }: CarryOverFinding): string => positionId;

type MatchCarriedDecisionsArgs = {
  current: readonly CarryOverFinding[];
  prior: readonly CarryOverFinding[];
};

/**
 * Pair each new finding with the decided prior finding it repeats verbatim.
 *
 * Three conditions, all required: the same position, a prior finding that
 * someone actually decided, and an identical fingerprint
 * (same outcome over the same cited evidence). A prior finding left `open`
 * carries nothing — the new finding is already open — and a new finding that
 * somehow already carries a decision is never overwritten, which is what makes
 * a replayed completion a no-op rather than a reset.
 */
export const matchCarriedDecisions = ({
  current,
  prior,
}: MatchCarriedDecisionsArgs): CarriedDecision[] => {
  const decidedPrior = new Map<string, CarryOverFinding>();
  for (const finding of prior) {
    if (finding.decision === DOCUMENT_REVIEW_DECISION.OPEN) {
      continue;
    }
    decidedPrior.set(comparisonKey(finding), finding);
  }
  if (decidedPrior.size === 0) {
    return [];
  }

  const carried: CarriedDecision[] = [];
  for (const finding of current) {
    if (finding.decision !== DOCUMENT_REVIEW_DECISION.OPEN) {
      continue;
    }
    const previous = decidedPrior.get(comparisonKey(finding));
    if (previous === undefined) {
      continue;
    }
    if (
      findingFingerprint(finding.payload, finding.outcome) !==
      findingFingerprint(previous.payload, previous.outcome)
    ) {
      continue;
    }
    carried.push({ findingId: finding.id, priorFindingId: previous.id });
  }
  return carried;
};

type CarryOverDecisionsArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
};

/**
 * Copy the decisions a completed run inherits from the document's previous
 * review. Returns how many decisions moved.
 *
 * "Previous review" is the newest completed run for the same document. There
 * is one basis shape and one finding shape now, so any earlier review of the
 * same document is that document's history; whether the conclusions actually
 * repeat is the fingerprint's question, not this query's.
 */
export const carryOverDecisions = async ({
  tx,
  workspaceId,
  runId,
  entityId,
  fileFieldId,
}: CarryOverDecisionsArgs): Promise<number> => {
  const previousRun = tx
    .select({ id: documentReviewRuns.id })
    .from(documentReviewRuns)
    .where(
      and(
        eq(documentReviewRuns.workspaceId, workspaceId),
        eq(documentReviewRuns.entityId, entityId),
        eq(documentReviewRuns.fileFieldId, fileFieldId),
        eq(documentReviewRuns.status, "completed"),
        ne(documentReviewRuns.id, runId),
      ),
    )
    .orderBy(desc(documentReviewRuns.createdAt), desc(documentReviewRuns.id))
    .limit(1);

  // Both sides in one read: the rows this run just committed, and the rows of
  // the review it supersedes.
  const rows = await tx
    .select({
      id: documentReviewFindings.id,
      runId: documentReviewFindings.runId,
      positionId: documentReviewFindings.positionId,
      outcome: documentReviewFindings.outcome,
      payload: documentReviewFindings.payload,
      decision: documentReviewFindings.decision,
    })
    .from(documentReviewFindings)
    .where(
      and(
        eq(documentReviewFindings.workspaceId, workspaceId),
        or(
          eq(documentReviewFindings.runId, runId),
          inArray(documentReviewFindings.runId, previousRun),
        ),
      ),
    )
    .limit(DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX * 2);

  const current: CarryOverFinding[] = [];
  const prior: CarryOverFinding[] = [];
  for (const row of rows) {
    (row.runId === runId ? current : prior).push(row);
  }

  const carried = matchCarriedDecisions({ current, prior });
  if (carried.length === 0) {
    return 0;
  }

  // The prior rows are joined back by id rather than having their decision,
  // decider, and timestamp shipped out and back as bind parameters: only ids
  // cross the boundary, so no value is re-encoded on the way.
  const pairs = carried.map(
    ({ findingId, priorFindingId }) =>
      sql`(${findingId}::uuid, ${priorFindingId}::uuid)`,
  );
  // audit: skip — the reviewer's decision was audited when it was taken; this
  // reattaches that same decision to the run that repeats its finding.
  await tx.execute(sql`
    UPDATE ${documentReviewFindings} AS target
       SET decision = prior.decision,
           decided_by = prior.decided_by,
           decided_at = prior.decided_at
      FROM (VALUES ${sql.join(pairs, sql`, `)}) AS pair(finding_id, prior_finding_id)
      JOIN ${documentReviewFindings} AS prior ON prior.id = pair.prior_finding_id
     WHERE target.id = pair.finding_id
       AND target.workspace_id = ${workspaceId}
       AND prior.workspace_id = ${workspaceId}
       AND target.decision = ${DOCUMENT_REVIEW_DECISION.OPEN}`);

  return carried.length;
};
