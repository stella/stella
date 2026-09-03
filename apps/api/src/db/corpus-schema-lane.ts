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
 * for its duration: `createIngestionDb` (the write boundary every worker
 * goes through) and the operator scripts' write door both run their
 * transactions through `runUnderCorpusSchemaLane`. The migrate entrypoint
 * takes the lane EXCLUSIVE for the whole upgrade
 * (`CORPUS_SCHEMA_LANE_LOCK_SQL`), which waits for the batches in flight;
 * once it is granted no corpus transaction is open, so DDL wins its table
 * lock at once with a short wait. Batches resume when the upgrade releases
 * the lane.
 *
 * A batch never *waits* for the lane inside a transaction. A transaction
 * blocked on a lock still holds its snapshot, and a concurrent index build
 * in the upgrade waits for every older snapshot to end: the build would wait
 * for the batch, and the batch for the build's lane, a deadlock PostgreSQL
 * resolves by aborting one side. So a batch *tries* the lane, and when
 * refused ends its empty transaction, sleeps, and tries again; nothing of it
 * outlives the attempt. PostgreSQL queues lock requests, so a try is refused
 * as soon as an exclusive request is waiting, which is what lets the upgrade
 * drain. The tries are bounded by the caller's budget: a batch that cannot
 * enter within it fails with `CorpusSchemaLaneUnavailableError` instead of
 * polling on after its caller has given up on it.
 *
 * Distinct from the operator scripts' maintenance lane
 * (`lib/case-law/maintenance-lane.ts`), which serializes whole operator runs
 * against each other for hours; a batch must not wait on that.
 *
 * Advisory locks need no grant, so the `stella_ingestion` role can take the
 * shared side. Only `better-result` is imported: `migrate.ts` ships as a
 * loose file with no path aliases, and `scoped.ts` must not pull the schema
 * in.
 */

import { TaggedError } from "better-result";

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
 * How long a batch keeps trying when no budget is given: longer than an
 * upgrade of the corpus tables takes, shorter than a stuck upgrade would
 * hold the lane before somebody notices.
 */
export const CORPUS_SCHEMA_LANE_DEFAULT_WAIT_MS = 20 * 60 * 1000;

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

/** A batch that could not enter the lane within its budget. */
export class CorpusSchemaLaneUnavailableError extends TaggedError(
  "CorpusSchemaLaneUnavailableError",
)<{
  message: string;
  waitedMs: number;
}> {}

/** The one thing a lane transaction needs from its transaction handle. */
export type CorpusSchemaLaneTransaction = {
  execute: (query: string) => PromiseLike<unknown>;
};

/** Anything that runs a transaction: a drizzle database, or a stand-in. */
export type CorpusSchemaLaneDatabase<
  TTransaction extends CorpusSchemaLaneTransaction,
> = {
  transaction: <TResult>(
    fn: (tx: TTransaction) => Promise<TResult>,
  ) => Promise<TResult>;
};

export type RunUnderCorpusSchemaLaneOptions<
  TTransaction extends CorpusSchemaLaneTransaction,
  TResult,
> = {
  /** Runs the transaction to try the lane in and, when granted, the work in. */
  database: CorpusSchemaLaneDatabase<TTransaction>;
  /** The work, run inside the transaction that holds the lane. */
  work: (tx: TTransaction) => Promise<TResult>;
  /** How long to keep trying; the caller's own budget for this transaction. */
  laneWaitMs?: number;
  /** Test seam; `Bun.sleep` otherwise. */
  sleep?: (ms: number) => Promise<void>;
};

/** A transaction that ended without running its work: the lane was refused. */
const LANE_BUSY: unique symbol = Symbol("stella.corpusSchemaLaneBusy");

/**
 * One transaction under the shared lane: try the lane, and only when granted
 * run the work. A refused attempt commits an empty transaction and the
 * caller sleeps outside any transaction before the next one, so no snapshot
 * outlives a refusal. Recursive rather than a loop with an awaited body:
 * each attempt must end before the next begins, so the sequencing is
 * structural.
 */
export const runUnderCorpusSchemaLane = async <
  TTransaction extends CorpusSchemaLaneTransaction,
  TResult,
>(
  {
    database,
    work,
    laneWaitMs = CORPUS_SCHEMA_LANE_DEFAULT_WAIT_MS,
    sleep = Bun.sleep,
  }: RunUnderCorpusSchemaLaneOptions<TTransaction, TResult>,
  waitedMs = 0,
): Promise<TResult> => {
  const outcome = await database.transaction(
    async (tx): Promise<typeof LANE_BUSY | { value: TResult }> => {
      const granted = isCorpusSchemaLaneGranted(
        await tx.execute(CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL),
      );
      if (!granted) {
        return LANE_BUSY;
      }
      return { value: await work(tx) };
    },
  );
  if (outcome !== LANE_BUSY) {
    return outcome.value;
  }
  if (waitedMs >= laneWaitMs) {
    throw new CorpusSchemaLaneUnavailableError({
      message: `The corpus schema lane stayed unavailable for ${String(waitedMs)}ms; an upgrade is holding it`,
      waitedMs,
    });
  }
  await sleep(CORPUS_SCHEMA_LANE_RETRY_MS);
  return await runUnderCorpusSchemaLane(
    { database, work, laneWaitMs, sleep },
    waitedMs + CORPUS_SCHEMA_LANE_RETRY_MS,
  );
};
