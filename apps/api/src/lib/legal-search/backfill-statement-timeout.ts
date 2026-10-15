import type { SQL } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import type { TransactionOf } from "@/api/db/scoped";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";

/**
 * Statement timeout for corpus backfill writes (the tsvector search
 * projections and the citation-authority recompute).
 *
 * `to_tsvector` + `unaccent` over long court decisions is CPU-bound.
 * A bounded shared-pool budget gives each batch room without allowing a
 * statement to outlive its connection's idle deadline.
 *
 * This bounds an actively executing statement and is independent of the
 * DB-level `idle_in_transaction_session_timeout`, which only fires on a
 * transaction sitting idle between statements, never on a running one.
 */
const CORPUS_BACKFILL_STATEMENT_TIMEOUT_MS = 100_000;

type StatementTimeoutTx = {
  execute: (query: SQL) => Promise<unknown>;
};

export const setCorpusBackfillStatementTimeout = async (
  tx: StatementTimeoutTx,
): Promise<void> => {
  await setSharedStatementTimeout(tx, CORPUS_BACKFILL_STATEMENT_TIMEOUT_MS);
};

const DEDICATED_STATEMENT_TIMEOUT_MS = 15 * 60_000;
const DEDICATED_LOCK_TIMEOUT_MS = 10_000;
const DEDICATED_ABORT_TIMEOUT_MS = 16 * 60_000;
const DEDICATED_LANE_WAIT_MS = 60_000;

/**
 * A single document projection may need more CPU than the shared pool can
 * grant. The backfill owns a dedicated connection for that document, enters
 * the ingestion role, and leaves it when the document reaches a terminal
 * result. Missing/stale probes select the same row again after a failure.
 */
export const withDedicatedCorpusBackfillDb = async <T>(
  work: (scopedDb: ScopedDb) => Promise<T>,
): Promise<T> => {
  const { withLongRunningConnection } =
    await import("@/api/db/long-running-connection");
  return await withLongRunningConnection(
    {
      statementTimeout: DEDICATED_STATEMENT_TIMEOUT_MS,
      lockTimeout: DEDICATED_LOCK_TIMEOUT_MS,
      signal: AbortSignal.timeout(DEDICATED_ABORT_TIMEOUT_MS),
    },
    async ({ db }) =>
      await work(
        createIngestionDb(
          markRlsDatabase({
            transaction: async <TResult>(
              fn: (tx: TransactionOf<typeof db>) => Promise<TResult>,
            ): Promise<TResult> => await db.transaction(fn),
          }),
          { laneWaitMs: DEDICATED_LANE_WAIT_MS },
        ),
      ),
  );
};
