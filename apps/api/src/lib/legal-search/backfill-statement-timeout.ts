import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

/**
 * Statement timeout for corpus backfill writes (the tsvector search
 * projections and the citation-authority recompute).
 *
 * `to_tsvector` + `unaccent` over long court decisions is CPU-bound and
 * outruns the default `statement_timeout`, so these transactions raise it
 * with a transaction-local setting; user-facing queries keep the default.
 * Single-sourced here so the backfill paths cannot drift.
 *
 * This bounds an actively executing statement and is independent of the
 * DB-level `idle_in_transaction_session_timeout`, which only fires on a
 * transaction sitting idle between statements, never on a running one.
 */
export const CORPUS_BACKFILL_STATEMENT_TIMEOUT = "15min";

type StatementTimeoutTx = {
  execute: (query: SQL) => Promise<unknown>;
};

export const setCorpusBackfillStatementTimeout = async (
  tx: StatementTimeoutTx,
): Promise<void> => {
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${CORPUS_BACKFILL_STATEMENT_TIMEOUT}, true)`,
  );
};
