import { getTableName, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

/**
 * A DB-backed property test is only memory-bounded if each run gives back what
 * it took. Two things in this stack do not do that on their own, so both grow
 * with `numRuns` rather than with the generated input, and the nightly
 * `PROPERTY_TEST_NUM_RUNS_FACTOR` sweep is what makes them visible as a DB test
 * batch over its peak-RSS budget:
 *
 *  1. PGlite runs Postgres with `max_worker_processes = 0`, so the autovacuum
 *     launcher never starts and the rows a run deletes stay as dead tuples for
 *     the life of the process. Measured on the entity-filter differential
 *     property, 15,000 runs: data dir 20 MB -> 149 MB, `entities` heap
 *     160 KB -> 27 MB, and the property itself 4.5x slower end to end.
 *  2. Under `bun --smol` the collector does not keep up with a long
 *     allocation-heavy async loop: most of the heap is the typed-array backing
 *     stores behind PGlite's wire buffers, and JSC grows the heap instead of
 *     collecting them. Same property, 3,000 runs: `extraMemorySize`
 *     551 MB -> 1200 MB and peak RSS 1248 MB -> 1833 MB, with a flat data dir.
 *     Collecting on the same interval holds it at ~560 MB / 1320 MB.
 *
 * Both are reclaimed on an interval rather than per run: a per-run VACUUM costs
 * about 3x the run itself, while at this interval neither reclaim is
 * measurable. What is retained is then bounded by the interval, a constant,
 * instead of by `numRuns`.
 */
const RECLAIM_INTERVAL_RUNS = 100;

/** Structural: raw and relations-aware drizzle instances both satisfy it. */
type ExecutingDb = { execute: (query: SQL) => Promise<unknown> };

/**
 * Build the per-run cleanup hook that keeps a property test's memory bounded.
 * Call the returned function once per property run, after the run's rows are
 * deleted, passing the tables that run wrote to.
 */
export const createPropertyRunReclaimer = (
  db: ExecutingDb,
  tables: readonly AnyPgTable[],
): (() => Promise<void>) => {
  const vacuum = sql`vacuum ${sql.join(
    tables.map((table) => sql.identifier(getTableName(table))),
    sql`, `,
  )}`;
  // Reclaim on the first call too, so a factor-1 PR run exercises this path
  // even for a property whose `numRuns` is below the interval.
  let runsSinceReclaim = RECLAIM_INTERVAL_RUNS - 1;

  return async () => {
    runsSinceReclaim += 1;
    if (runsSinceReclaim < RECLAIM_INTERVAL_RUNS) {
      return;
    }
    runsSinceReclaim = 0;
    await db.execute(vacuum);
    Bun.gc(true);
  };
};
