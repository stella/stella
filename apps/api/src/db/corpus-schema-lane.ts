/**
 * The corpus schema lane: how schema changes and corpus writers share the
 * high-volume tables without racing for table locks.
 *
 * The corpus workers (ingestion, projection, packing, polarity, authority)
 * write to `case_law_*` and `corpus_index_*` in batch transactions that
 * follow one another without pause. DDL on those tables needs ACCESS
 * EXCLUSIVE, which a short lock wait never wins against such a stream, and a
 * long wait stalls every reader queued behind it. Retrying with longer waits
 * shifts the odds; it does not remove the race.
 *
 * The lane removes it. Every corpus batch transaction holds the lane SHARED
 * for its duration (applied by `createIngestionDb`, the write boundary every
 * corpus writer goes through). The migrate entrypoint takes the lane
 * EXCLUSIVE for the whole upgrade (`CORPUS_SCHEMA_LANE_LOCK_SQL`), which
 * waits for the batches in flight; once it is granted no corpus transaction
 * is open, so DDL wins its table lock at once with a short wait. Batches
 * resume when the upgrade releases the lane.
 *
 * A batch never *waits* for the lane inside a transaction. A transaction
 * blocked on a lock still holds its snapshot, and a concurrent index build
 * in the upgrade waits for every older snapshot to end: the build would wait
 * for the batch, and the batch for the build's lane, a deadlock PostgreSQL
 * resolves by aborting one side. So a batch *tries* the lane
 * (`CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL`), and when refused it ends its
 * empty transaction, sleeps, and tries again; nothing of it outlives the
 * attempt. PostgreSQL queues lock requests, so a try is refused as soon as
 * an exclusive request is waiting, which is what lets the upgrade drain.
 *
 * Distinct from the operator scripts' maintenance lane
 * (`lib/case-law/maintenance-lane.ts`), which serializes whole operator runs
 * against each other for hours; a batch must not wait on that.
 *
 * Advisory locks need no grant, so the `stella_ingestion` role can take the
 * shared side. No imports: `migrate.ts` ships as a loose file with no path
 * aliases, and `scoped.ts` must not pull the schema in.
 */

/** The `(int, int)` key of the lane, as `hashtext` renders the two halves. */
export const CORPUS_SCHEMA_LANE = {
  domain: "case_law",
  lane: "schema",
} as const;

const KEY_SQL = `hashtext('${CORPUS_SCHEMA_LANE.domain}'), hashtext('${CORPUS_SCHEMA_LANE.lane}')`;

/**
 * Try the lane shared for the current transaction; one row, `granted`
 * boolean. Held until commit or rollback when granted.
 */
export const CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL = `SELECT pg_try_advisory_xact_lock_shared(${KEY_SQL}) AS "granted"`;

/** How long a refused batch sleeps, outside any transaction, before trying again. */
export const CORPUS_SCHEMA_LANE_RETRY_MS = 250;

/**
 * Take the lane exclusive for the session. Blocks until every shared holder
 * has committed; pair with `CORPUS_SCHEMA_LANE_UNLOCK_SQL` on the same
 * connection, and let the session end release it on any other exit. The
 * holder waits with nothing else held, so it cannot deadlock.
 */
export const CORPUS_SCHEMA_LANE_LOCK_SQL = `SELECT pg_advisory_lock(${KEY_SQL})`;

export const CORPUS_SCHEMA_LANE_UNLOCK_SQL = `SELECT pg_advisory_unlock(${KEY_SQL})`;

/** Whether a try-lock result (either driver shape) reports the lane granted. */
export const isCorpusSchemaLaneGranted = (result: unknown): boolean => {
  let rows: unknown[] = [];
  if (Array.isArray(result)) {
    rows = result;
  } else if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray(result.rows)
  ) {
    rows = result.rows;
  }
  const row: unknown = rows.at(0);
  return (
    typeof row === "object" &&
    row !== null &&
    "granted" in row &&
    row.granted === true
  );
};
