import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

import { caseLawIndexJobs } from "@/api/db/schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

/**
 * The one owner of what counts as an erasure recorded since a copy was
 * reserved. Every site that decides about a superseded copy a state still
 * names by that record asks here: the one-off pass
 * (`retireLegacyUnprovenServedCopiesTx`) and the repair writer's hold for it.
 *
 * The record is the case-law index-job trail: a succeeded `withdraw` row is
 * written in the transaction that withdraws a decision's document
 * (`recordCorpusWithdrawalAuditEvent`), with the canonical change and the
 * desired erasure. Legislation has no such record.
 */

type CorpusProjectionErasureWindow = {
  family: CorpusFamily;
  /** The entity whose copy is decided. */
  entityId: SQLWrapper;
  /** When that copy was reserved: the named revision's `created_at`. */
  reservedAt: SQLWrapper;
  /** The window's end, or `null` for none. */
  before: SQLWrapper | null;
};

/**
 * Recorded evidence that an erasure was written for the entity since its copy
 * was reserved: a succeeded `withdraw` row in `[reservedAt, before)`, judged
 * on the row's `created_at`, which is its transaction's start.
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
