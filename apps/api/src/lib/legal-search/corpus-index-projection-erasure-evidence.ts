import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawIndexJobs,
} from "@/api/db/schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

/**
 * The one owner of what counts as an erasure recorded since a copy was
 * reserved. Every site that decides about a superseded copy a state still
 * names asks here: the cleanup claim (`claimCorpusProjectionCleanupTx`), the
 * one-off pass (`retireLegacyUnprovenServedCopiesTx`) and the repair writer's
 * hold for it. The database guard on a queued copy's restore repeats
 * `corpusProjectionErasureIsExcluded`.
 *
 * The record is the case-law index-job trail: a succeeded `withdraw` row is
 * written in the transaction that withdraws a decision's document
 * (`recordCorpusWithdrawalAuditEvent`), with the canonical change and the
 * desired erasure. Legislation has no such record.
 */

type CorpusProjectionErasureEvidenceColumns = {
  family: CorpusFamily;
  /** The entity whose copy is decided. */
  entityId: SQLWrapper;
  /** When that copy was reserved: the named revision's `created_at`. */
  reservedAt: SQLWrapper;
};

type CorpusProjectionErasureWindow = CorpusProjectionErasureEvidenceColumns & {
  /** The window's end, or `null` for none. */
  before: SQLWrapper | null;
};

/**
 * Recorded evidence that an erasure was written for the entity since its copy
 * was reserved: a succeeded `withdraw` row in `[reservedAt, before)`, judged
 * on the row's `created_at`. The writer stamps it after the withdrawal's
 * desired-state write (`recordCorpusWithdrawalAuditEvent`), so it follows the
 * reservation of every copy applied before the withdrawal reached the state.
 *
 * The window starts at the copy's reservation: a copy is applied only while
 * the desired state still equals it, so an erasure written before the
 * reservation was undone before the copy's content was chosen, and the copy
 * holds content desired after it.
 */
export const corpusProjectionErasureIsRecorded = ({
  family,
  entityId,
  reservedAt,
  before,
}: CorpusProjectionErasureWindow): SQL => {
  const evidence = {
    case_law: sql`EXISTS (
      SELECT 1 FROM ${caseLawIndexJobs}
      WHERE ${caseLawIndexJobs.decisionId} = ${entityId}
        AND ${caseLawIndexJobs.operation} = 'withdraw'
        AND ${caseLawIndexJobs.status} = 'succeeded'
        AND ${caseLawIndexJobs.createdAt} >= ${reservedAt}::timestamptz
        ${before === null ? sql`` : sql`AND ${caseLawIndexJobs.createdAt} < ${before}::timestamptz`}
    )`,
    legislation: sql`false`,
  } satisfies Record<CorpusFamily, SQL>;
  return evidence[family];
};

/**
 * No erasure of the entity is recorded since the copy was reserved: the
 * canonical row still exists, is not redacted and has not settled without a
 * document, no redaction was ever recorded for it, and no withdrawal was
 * recorded since the reservation. The window has no end: a later withdrawal is
 * one this copy went through too.
 *
 * Only a recorded erasure counts: any other change of the decision leaves the
 * copy serving until it is appended anew.
 *
 * - A row whose document is pending has no content hash yet, and has not
 *   settled.
 * - A redaction is permanent, so any `redact` row counts, as it does for the
 *   canonical row's own redaction fence.
 * - Legislation is decided by the projection rows alone.
 *
 * The caller holds the naming state's row lock and reads this in a statement
 * issued after taking it. A withdrawal writes its trail row and its desired
 * erasure in one transaction, and an undo writes the state after it, so each
 * either committed before the lock was taken, and its row is visible here, or
 * reaches the state only after the caller's transaction ends and then finds
 * the copy `applied`, where the desired writer un-names it.
 */
export const corpusProjectionErasureIsExcluded = ({
  family,
  entityId,
  reservedAt,
}: CorpusProjectionErasureEvidenceColumns): SQL => {
  const excluded = {
    // Scalar probes by the decision's id, never a semi-join the planner could
    // hash a whole table for.
    case_law: sql`(
      (
        SELECT ${caseLawDecisions.redactedAt} IS NULL
          AND (
            ${caseLawDecisions.contentHash} IS NOT NULL
            OR ${caseLawDecisions.corpusMirrorStatus} = ${CASE_LAW_CORPUS_MIRROR_STATUS.PENDING}
          )
        FROM ${caseLawDecisions}
        WHERE ${caseLawDecisions.id} = ${entityId}
      ) IS TRUE
      AND NOT ${corpusProjectionErasureIsRecorded({
        family,
        entityId,
        reservedAt,
        before: null,
      })}
      AND (
        SELECT true FROM ${caseLawIndexJobs}
        WHERE ${caseLawIndexJobs.decisionId} = ${entityId}
          AND ${caseLawIndexJobs.operation} = 'redact'
        LIMIT 1
      ) IS NULL
    )`,
    legislation: sql`false`,
  } satisfies Record<CorpusFamily, SQL>;
  return excluded[family];
};
