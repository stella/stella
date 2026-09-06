import { sql, type SQLWrapper } from "drizzle-orm";

import {
  CORPUS_INDEX_APPEND_PRODUCING_INTENT_STATUSES,
  CORPUS_INDEX_QUIESCENT_INTENT_STATUSES,
} from "@/api/lib/legal-search/corpus-index-projection-contract";

const sqlLiteralValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql.raw(","),
  );

type CorpusProjectionWorkColumns = {
  workStatus: SQLWrapper;
  appliedAction: SQLWrapper;
  desiredAction: SQLWrapper;
  appliedEpoch: SQLWrapper;
  desiredEpoch: SQLWrapper;
  appliedFingerprint: SQLWrapper;
  desiredFingerprint: SQLWrapper;
  appliedIndexId: SQLWrapper;
  desiredIndexId: SQLWrapper;
};

/** One source of truth for the scheduler and its partial queue index. */
export const corpusIndexProjectionNeedsWork = ({
  workStatus,
  appliedAction,
  desiredAction,
  appliedEpoch,
  desiredEpoch,
  appliedFingerprint,
  desiredFingerprint,
  appliedIndexId,
  desiredIndexId,
}: CorpusProjectionWorkColumns) => sql`(
  ${workStatus} = 'repair_scheduled'
  OR (
    ${workStatus} IN ('eligible', 'retry_scheduled')
    AND (
      ${appliedAction} IS NULL
      OR ${appliedAction} IS DISTINCT FROM ${desiredAction}
      OR ${appliedEpoch} IS DISTINCT FROM ${desiredEpoch}
      OR ${appliedFingerprint} IS DISTINCT FROM ${desiredFingerprint}
      OR ${appliedIndexId} IS DISTINCT FROM ${desiredIndexId}
    )
  )
)`;

export const corpusIndexProjectionIsBlocked = (workStatus: SQLWrapper) =>
  sql`${workStatus} = 'blocked'`;

/** One source of truth for the partial append-epoch uniqueness boundary. */
export const corpusIndexProjectionProducesAppend = (status: SQLWrapper) =>
  sql`${status} IN (${sqlLiteralValues(CORPUS_INDEX_APPEND_PRODUCING_INTENT_STATUSES)})`;

/**
 * One source of truth for "this entity still owes the index an exact action",
 * shared by the append and erasure anti-joins and by the partial index that
 * answers them. The index predicate and the query predicate are the same
 * expression, so PostgreSQL can prove the implication and the probe never
 * walks an entity's quiescent revision history, however long it grows.
 */
export const corpusIndexProjectionIntentIsOutstanding = (status: SQLWrapper) =>
  sql`${status} NOT IN (${sqlLiteralValues(CORPUS_INDEX_QUIESCENT_INTENT_STATUSES)})`;
