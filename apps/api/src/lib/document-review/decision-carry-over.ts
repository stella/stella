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
 *
 * The earlier run is found, and what became of each answered prior finding is
 * named, by the review carry-over core (`carry-over-core.ts`), shared
 * with list verification. Outcomes are returned, not stored: a finding row
 * keeps its decision and flags, and the run read shows them, so nothing
 * reads an outcome back yet.
 */

import { panic } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { stableStringify } from "@stll/stable-stringify";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { CarryOutcome } from "@/api/lib/document-review/carry-outcomes";
import type { DocumentRunColumns } from "@/api/lib/document-review/carry-over-core";
import { previousCompletedRunQuery } from "@/api/lib/document-review/carry-over-core";
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

/** The carried pairs, and what became of every answered prior finding. */
export type CarryPlan = {
  carried: CarriedDecision[];
  outcomes: Map<SafeId<"documentReviewFinding">, CarryOutcome>;
};

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
export const planCarriedDecisions = ({
  current,
  prior,
  currentPositions,
  priorPositions,
}: MatchCarriedDecisionsArgs): CarryPlan => {
  const answeredPrior = new Map<string, CarryOverFinding>();
  for (const finding of prior) {
    if (!wasAnswered(finding)) {
      continue;
    }
    answeredPrior.set(comparisonKey(finding), finding);
  }
  const outcomes = new Map<SafeId<"documentReviewFinding">, CarryOutcome>();
  if (answeredPrior.size === 0) {
    return { carried: [], outcomes };
  }
  // A position the new run did not answer leaves its reading behind.
  for (const previous of answeredPrior.values()) {
    outcomes.set(previous.id, "unmatched");
  }

  const currentById = positionsById(currentPositions);
  const priorById = positionsById(priorPositions);

  const carried: CarriedDecision[] = [];
  for (const finding of current) {
    const previous = answeredPrior.get(comparisonKey(finding));
    if (previous === undefined) {
      continue;
    }
    // A finding already answered on this run (a replayed completion) is
    // not the prior reading's to fill.
    if (!isUntouched(finding)) {
      outcomes.delete(previous.id);
      continue;
    }
    const currentPosition = currentById.get(finding.positionId);
    const priorPosition = priorById.get(finding.positionId);
    if (finding.outcome !== previous.outcome) {
      outcomes.set(previous.id, "verdict-changed");
      continue;
    }
    if (
      findingFingerprint(finding.payload, finding.outcome) !==
      findingFingerprint(previous.payload, previous.outcome)
    ) {
      outcomes.set(previous.id, "text-changed");
      continue;
    }
    if (
      currentPosition === undefined ||
      priorPosition === undefined ||
      positionStandard(currentPosition) !== positionStandard(priorPosition)
    ) {
      // Measured against another standard: the verdict a reviewer judged
      // is not the one this run gives.
      outcomes.set(previous.id, "verdict-changed");
      continue;
    }
    outcomes.set(previous.id, "carried");
    carried.push({ findingId: finding.id, priorFindingId: previous.id });
  }
  return { carried, outcomes };
};

/** The carried pairs alone. */
export const matchCarriedDecisions = (
  args: MatchCarriedDecisionsArgs,
): CarriedDecision[] => planCarriedDecisions(args).carried;

/** The document review run columns the shared previous-run lookup reads. */
const DOCUMENT_REVIEW_RUN_COLUMNS = {
  table: documentReviewRuns,
  id: documentReviewRuns.id,
  workspaceId: documentReviewRuns.workspaceId,
  entityId: documentReviewRuns.entityId,
  fileFieldId: documentReviewRuns.fileFieldId,
  status: documentReviewRuns.status,
  createdAt: documentReviewRuns.createdAt,
} satisfies DocumentRunColumns<"documentReviewRun">;

/** How many findings inherited a reading, and what became of every
 *  answered finding of the previous review, keyed by that finding. */
export type CarryOverResult = {
  carried: number;
  outcomes: ReadonlyMap<SafeId<"documentReviewFinding">, CarryOutcome>;
};

const NOTHING_CARRIED: CarryOverResult = { carried: 0, outcomes: new Map() };

type CarryOverDecisionsArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
};

/**
 * Copy the readings a completed run inherits from the document's previous
 * review. Returns how many findings inherited one, and the outcome of every
 * answered finding of that review.
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
}: CarryOverDecisionsArgs): Promise<CarryOverResult> => {
  const previousRun = previousCompletedRunQuery({
    tx,
    columns: DOCUMENT_REVIEW_RUN_COLUMNS,
    run: { id: runId, workspaceId, entityId, fileFieldId },
  });

  const runsRead = await readBounded(
    tx
      .select({ id: documentReviewRuns.id, basis: documentReviewRuns.basis })
      .from(documentReviewRuns)
      .where(
        and(
          eq(documentReviewRuns.workspaceId, workspaceId),
          // Bounded by this run and one previous run.
          or(
            eq(documentReviewRuns.id, runId),
            inArray(documentReviewRuns.id, previousRun),
          ),
        ),
      ),
    2,
  );
  if (runsRead.type === "overflow") {
    return panic("Carry-over matched more than this run and one previous run");
  }
  const runs = runsRead.rows;
  const thisRun =
    runs.find(({ id }) => id === runId) ??
    panic("Carry-over ran for a review run that does not exist");
  const priorRun = runs.find(({ id }) => id !== runId);
  if (priorRun === undefined) {
    return NOTHING_CARRIED;
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

  const { carried, outcomes } = planCarriedDecisions({
    current,
    prior,
    currentPositions: thisRun.basis.playbook.definitionSnapshot.positions.items,
    priorPositions: priorRun.basis.playbook.definitionSnapshot.positions.items,
  });
  if (carried.length === 0) {
    return { carried: 0, outcomes };
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

  return { carried: carried.length, outcomes };
};
