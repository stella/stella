/**
 * Carry a reviewer's reading of a finding — the decision they took and the
 * flags they put beside it — across re-runs.
 *
 * Re-reviewing a document must not silently discard the reading a lawyer
 * already did. When a new run reaches the same conclusion about the same
 * quoted text as the previous review of that document, against the same
 * position rules, the earlier decision and flags still apply and move onto the
 * new finding. When the conclusion, the evidence, or the rules changed, the
 * finding stays `open` and unflagged, because that is the case a reviewer has
 * to look at again.
 *
 * Cost: three statements per completed run, regardless of how many findings it
 * holds. One SELECT reads the pinned basis of this run and of the previous
 * completed run (at most two rows); one reads both runs' findings (both bounded
 * by the confirmed-topic cap); one UPDATE copies every match by joining the
 * prior rows back through their ids, so no decision, decider, or timestamp is
 * round-tripped through the application.
 */

import { panic } from "better-result";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import { stableStringify } from "@stll/stable-stringify";

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
  DocumentReviewFindingFlag,
  DocumentReviewFindingPayload,
} from "@/api/lib/document-review/run-contract";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import {
  canonicalRulesInput,
  isTierStandard,
} from "@/api/lib/workflow/position-runtime";

/** What matching needs from a finding row, on either side of the comparison. */
export type CarryOverFinding = {
  id: SafeId<"documentReviewFinding">;
  positionId: string;
  outcome: string | null;
  payload: DocumentReviewFindingPayload;
  decision: DocumentReviewDecision;
  flags: readonly DocumentReviewFindingFlag[];
};

/** One reading to copy: the new finding, and the answered finding it repeats. */
export type CarriedDecision = {
  findingId: SafeId<"documentReviewFinding">;
  priorFindingId: SafeId<"documentReviewFinding">;
};

/** A finding answers one position, which is what makes two findings from
 *  different runs comparable at all. */
const comparisonKey = ({ positionId }: CarryOverFinding): string => positionId;

/**
 * What a decision about a position was measured against. Two positions with the
 * same value hold the same standard, so an earlier decision still applies.
 *
 * Tier rules are compared on their inputs rather than on `computeRulesHash`:
 * that hash decides when to re-derive a question, and a change to derivation
 * must not reopen a lawyer's decision. A reference or extract position compares
 * by kind alone, because a finding's citations already cover what it read.
 */
const positionStandard = (position: Position): string => {
  if (isTierStandard(position)) {
    return stableStringify(canonicalRulesInput(position));
  }
  return position.mode === "graded" ? position.standard.source : position.mode;
};

const positionsById = (
  positions: readonly Position[],
): ReadonlyMap<string, Position> =>
  new Map(positions.map((position) => [position.sourceId, position]));

type MatchCarriedDecisionsArgs = {
  current: readonly CarryOverFinding[];
  prior: readonly CarryOverFinding[];
  /** The positions each run pinned. */
  currentPositions: readonly Position[];
  priorPositions: readonly Position[];
};

/** Whether a prior finding holds a reading worth moving forward. Flags count
 *  on their own: a reviewer who flagged a finding "follow-up" without yet
 *  deciding it has still done work the re-run must not erase. */
const wasAnswered = ({ decision, flags }: CarryOverFinding): boolean =>
  decision !== DOCUMENT_REVIEW_DECISION.OPEN || flags.length > 0;

/** Whether a new finding is still untouched, and so has room to inherit. A
 *  row is born this way, which is what makes a replayed completion a no-op
 *  rather than a reset. */
const isUntouched = ({ decision, flags }: CarryOverFinding): boolean =>
  decision === DOCUMENT_REVIEW_DECISION.OPEN && flags.length === 0;

/**
 * Pair each new finding with the answered prior finding it repeats verbatim.
 *
 * Four conditions, all required: the same position, a prior finding somebody
 * actually answered (decided, flagged, or both), an identical fingerprint (same
 * outcome over the same cited evidence), and the same rules on both runs' pinned
 * positions. A pin is JSON with no constraint tying it to the finding rows, and
 * a run migrated from the older basis can hold a finding whose position it does
 * not list. No rules to compare means no way to say the decision still applies.
 */
export const matchCarriedDecisions = ({
  current,
  prior,
  currentPositions,
  priorPositions,
}: MatchCarriedDecisionsArgs): CarriedDecision[] => {
  const answeredPrior = new Map<string, CarryOverFinding>();
  for (const finding of prior) {
    if (!wasAnswered(finding)) {
      continue;
    }
    answeredPrior.set(comparisonKey(finding), finding);
  }
  if (answeredPrior.size === 0) {
    return [];
  }

  const currentById = positionsById(currentPositions);
  const priorById = positionsById(priorPositions);

  const carried: CarriedDecision[] = [];
  for (const finding of current) {
    if (!isUntouched(finding)) {
      continue;
    }
    const previous = answeredPrior.get(comparisonKey(finding));
    if (previous === undefined) {
      continue;
    }
    if (
      findingFingerprint(finding.payload, finding.outcome) !==
      findingFingerprint(previous.payload, previous.outcome)
    ) {
      continue;
    }
    const currentPosition = currentById.get(finding.positionId);
    const priorPosition = priorById.get(finding.positionId);
    if (
      currentPosition === undefined ||
      priorPosition === undefined ||
      positionStandard(currentPosition) !== positionStandard(priorPosition)
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
 * Copy the readings a completed run inherits from the document's previous
 * review. Returns how many findings inherited one.
 *
 * "Previous review" is the newest completed run for the same document. There
 * is one basis shape and one finding shape now, so any earlier review of the
 * same document is that document's history; whether the conclusions actually
 * repeat, against the same rules, is the matcher's question, not this query's.
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

  const runs = await tx
    .select({ id: documentReviewRuns.id, basis: documentReviewRuns.basis })
    .from(documentReviewRuns)
    .where(
      and(
        eq(documentReviewRuns.workspaceId, workspaceId),
        // sql-perf-allow: bounded by this run and one previous run
        or(
          eq(documentReviewRuns.id, runId),
          inArray(documentReviewRuns.id, previousRun),
        ),
      ),
    )
    .limit(2);
  const thisRun =
    runs.find(({ id }) => id === runId) ??
    panic("Carry-over ran for a review run that does not exist");
  const priorRun = runs.find(({ id }) => id !== runId);
  if (priorRun === undefined) {
    return 0;
  }

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
      flags: documentReviewFindings.flags,
    })
    .from(documentReviewFindings)
    .where(
      and(
        eq(documentReviewFindings.workspaceId, workspaceId),
        inArray(documentReviewFindings.runId, [runId, priorRun.id]),
      ),
    )
    .limit(DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX * 2);

  const current: CarryOverFinding[] = [];
  const prior: CarryOverFinding[] = [];
  for (const row of rows) {
    (row.runId === runId ? current : prior).push(row);
  }

  const carried = matchCarriedDecisions({
    current,
    prior,
    currentPositions: thisRun.basis.playbook.definitionSnapshot.positions.items,
    priorPositions: priorRun.basis.playbook.definitionSnapshot.positions.items,
  });
  if (carried.length === 0) {
    return 0;
  }

  // The prior rows are joined back by id rather than having their decision,
  // decider, timestamp, and flags shipped out and back as bind parameters:
  // only ids cross the boundary, so no value is re-encoded on the way.
  const pairs = carried.map(
    ({ findingId, priorFindingId }) =>
      sql`(${findingId}::uuid, ${priorFindingId}::uuid)`,
  );
  // The `WHERE` repeats the matcher's untouched test so a concurrent decision
  // taken between the match and this statement wins over the inheritance.
  //
  // audit: skip — the reviewer's decision and flags were audited when they
  // were taken; this reattaches the same reading to the run that repeats its
  // finding.
  await tx.execute(sql`
    UPDATE ${documentReviewFindings} AS target
       SET decision = prior.decision,
           decided_by = prior.decided_by,
           decided_at = prior.decided_at,
           flags = prior.flags
      FROM (VALUES ${sql.join(pairs, sql`, `)}) AS pair(finding_id, prior_finding_id)
      JOIN ${documentReviewFindings} AS prior ON prior.id = pair.prior_finding_id
     WHERE target.id = pair.finding_id
       AND target.workspace_id = ${workspaceId}
       AND prior.workspace_id = ${workspaceId}
       AND target.decision = ${DOCUMENT_REVIEW_DECISION.OPEN}
       AND cardinality(target.flags) = 0`);

  return carried.length;
};
