import { sql } from "drizzle-orm";

/**
 * The legal-atlas-runner's single sanctioned database surface.
 *
 * The runner daemons are long-lived: an un-timed-out DB await on a
 * pooled connection the server reaped silently hangs forever, wedging
 * the whole worker until external supervision restarts it. Every DB
 * operation here is wrapped in `withTimeout`, so a dead connection rejects
 * and the adapter loop retries instead.
 *
 * `no-restricted-imports` (oxlint.config.ts) bans the raw `@/api/db/root`
 * pools and `createIngestionDb` elsewhere in this package, so this is the
 * only way the daemons can reach the database — no caller can construct
 * an unbounded handle.
 */
import type { ScopedDb } from "@/api/db";
import { createIngestionDb } from "@/api/db";
import { rootDb, rlsDb } from "@/api/db/root";
import { caseLawSources } from "@/api/db/schema";
import { withTimeout } from "@/api/lib/with-timeout";

import { LEGAL_ATLAS_RUNNER_ENV } from "./env";

const rawIngestionDb = createIngestionDb(rlsDb);
const transactionTimeoutMs = LEGAL_ATLAS_RUNNER_ENV.dbTransactionTimeoutMs;
const backfillTransactionTimeoutMs =
  LEGAL_ATLAS_RUNNER_ENV.dbBackfillTransactionTimeoutMs;
const TRANSACTION_TIMEOUT_GRACE_MS = 30_000;
const rootQueryTimeoutMs = LEGAL_ATLAS_RUNNER_ENV.dbRootQueryTimeoutMs;

/**
 * Build a `stella_ingestion`-scoped transaction runner with a per-transaction
 * budget. Postgres owns the normal cancellation path through SET LOCAL
 * statement_timeout; the outer wall-clock grace only catches sockets that
 * never deliver that server-side failure — including a statement that
 * completed server-side but whose result a reaped connection never returns,
 * which otherwise leaves the transaction idle and the awaiting caller
 * suspended forever.
 */
const createBoundedIngestionDb =
  (label: string, timeoutMs: number): ScopedDb =>
  async (fn) => {
    const operation = async () =>
      await rawIngestionDb(async (tx) => {
        if (timeoutMs > 0) {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`,
          );
        }

        return await fn(tx);
      });

    return await withTimeout(operation, {
      label,
      timeoutMs: timeoutMs === 0 ? 0 : timeoutMs + TRANSACTION_TIMEOUT_GRACE_MS,
    });
  };

/** Transaction runner for adapter ingest cycles (long pipeline writes). */
export const ingestionDb: ScopedDb = createBoundedIngestionDb(
  "ingestion-db-transaction",
  transactionTimeoutMs,
);

/**
 * Transaction runner for the index-maintenance backfill loops. Same bounded
 * mechanism as `ingestionDb`, but with its own tighter budget: a backfill
 * transaction is a batch select, an audit insert, or a single-document
 * projection upsert (the tsvector paths raise their statement_timeout to
 * CORPUS_BACKFILL_STATEMENT_TIMEOUT, which this budget must stay above), so
 * a wedged one rejects and retries on a backfill timescale instead of
 * holding its loop for the full ingest ceiling.
 */
export const backfillDb: ScopedDb = createBoundedIngestionDb(
  "backfill-db-transaction",
  backfillTransactionTimeoutMs,
);

type CaseLawSource = typeof caseLawSources.$inferSelect;

type NewCaseLawSource = {
  adapterKey: string;
  name: string;
  syncCursor: string | null;
};

/**
 * Look up a source by adapter key. Uses the root pool because the
 * ingestion role has only narrow grants on `case_law_sources`.
 */
export const findCaseLawSource = async (
  adapterKey: string,
): Promise<CaseLawSource | undefined> =>
  await withTimeout(
    () => rootDb.query.caseLawSources.findFirst({ where: { adapterKey } }),
    { label: "case-law-source-lookup", timeoutMs: rootQueryTimeoutMs },
  );

/**
 * Seed a source row. The ingestion role cannot INSERT into
 * `case_law_sources` (it gets SELECT plus a narrow cursor UPDATE), so
 * this one-time create runs on the root pool.
 */
export const createCaseLawSource = async (
  input: NewCaseLawSource,
): Promise<CaseLawSource | undefined> =>
  await withTimeout(
    async () => {
      const created = (
        await rootDb
          .insert(caseLawSources)
          .values({ ...input, config: {} })
          .returning()
      ).at(0);
      return created;
    },
    { label: "case-law-source-create", timeoutMs: rootQueryTimeoutMs },
  );
