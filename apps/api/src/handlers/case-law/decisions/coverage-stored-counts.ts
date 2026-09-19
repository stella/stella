import { sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/**
 * The two per-source figures the coverage page needs from the decisions table,
 * as one bounded read.
 *
 * They count different populations on purpose, and the field names say which:
 *
 * - `stored` counts everything the corpus holds for the source, listing-only
 *   identities included. It is the numerator of a completeness whose
 *   denominator is the publisher's own total, and a publisher counts every
 *   document it lists, so excluding the identities whose document has not
 *   arrived would understate coverage against that total. It is never the
 *   searchable count and is never presented as one.
 * - `addedLastWeek` counts what became public in the window, so it carries
 *   `publishedCaseLawDecisionSqlFor` like every other public read: "what
 *   arrived" is a claim about the corpus a reader can see.
 *
 * Neither read returns a decision row. A count of listing-only identities
 * discloses an integer, not the identities, which is why the census in
 * `tests/security/case-law-public-route-invariants.test.ts` admits this module
 * under its own gate rather than under the publication predicate.
 */

const WEEK_IN_MS = 7 * DAY_IN_MS;

/**
 * How many rows of one source the count walks before it answers with a floor.
 *
 * Set above any corpus a single court feed plausibly holds, so the ordinary
 * answer is exact; what actually bounds the read is the timeout below. The
 * limit is here because a count that cannot be bounded in rows has no honest
 * answer at all once it is exceeded, and "at least N" is one.
 */
export const COVERAGE_STORED_COUNT_CAP = 5_000_000;

/**
 * How long the whole per-source read may run.
 *
 * Warm, each arm is an index-only range over
 * `case_law_decisions_source_generation_cursor_idx`, which is led by
 * `source_id`, so a source is one contiguous range rather than a walk of the
 * corpus. Cold, or on an instance whose index is not cached, the largest
 * source's range is millions of entries: the bound is what turns that into a
 * visible `count-unavailable` instead of a public page sitting on a
 * two-connection pool. The statement is cancelled in the database, and the
 * caller reports every source as uncounted for the cache window.
 */
const COVERAGE_COUNT_STATEMENT_TIMEOUT = "10s";

export type CaseLawSourceCounts = {
  /** Everything held for the source; `capped` when the walk hit the bound. */
  stored: number;
  capped: boolean;
  /** Decisions published for the source in the last seven days. */
  addedLastWeek: number;
};

type SourceCountsRead = {
  sourceIds: readonly SafeId<"caseLawSource">[];
  /** The instant the window is measured back from. */
  now: Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Drivers disagree: bun-sql returns the rows, pglite wraps them in `{ rows }`. */
const rowsOf = (result: unknown): Record<string, unknown>[] => {
  let rows: unknown = result;
  if (!Array.isArray(result) && isRecord(result)) {
    rows = result["rows"];
  }
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
};

const toCount = (value: unknown): number => {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
};

/**
 * The transaction's current statement timeout, so the bound this read sets can
 * be handed back. Null when the setting cannot be read, which leaves the bound
 * in place for the rest of the transaction rather than guessing a value to
 * restore.
 */
const readStatementTimeout = async (
  tx: CaseLawPublicReadTransaction,
): Promise<string | null> => {
  const result: unknown = await tx.execute(
    sql`SELECT current_setting('statement_timeout') AS statement_timeout`,
  );
  const value = rowsOf(result).at(0)?.["statement_timeout"];
  return typeof value === "string" ? value : null;
};

export const readCaseLawSourceCountsQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCoverageCounts,
  async (
    tx: CaseLawPublicReadTransaction,
    { now, sourceIds }: SourceCountsRead,
  ): Promise<ReadonlyMap<string, CaseLawSourceCounts>> => {
    if (sourceIds.length === 0) {
      return new Map();
    }
    const sinceWeek = new Date(now.getTime() - WEEK_IN_MS);
    const published = sql.raw(publishedCaseLawDecisionSqlFor("d"));

    // Transaction-local and handed back below: the coverage read is one of
    // several this transaction runs, and the next of them must not inherit a
    // ten-second bound. `set_config(..., true)` reverts with the transaction,
    // so a cancelled statement needs no unwinding of its own.
    const previousTimeout = await readStatementTimeout(tx);
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${COVERAGE_COUNT_STATEMENT_TIMEOUT}, true)`,
    );

    const result: unknown = await tx.execute(sql`
      SELECT
        named.source_id AS source_id,
        held.stored AS stored,
        recent.added_last_week AS added_last_week
      FROM jsonb_array_elements_text(${JSON.stringify([...sourceIds])}::text::jsonb)
        WITH ORDINALITY AS named(source_id, ordinality)
      LEFT JOIN LATERAL (
        SELECT count(*) AS stored
        FROM (
          SELECT 1
          FROM case_law_decisions d
          WHERE d.source_id = named.source_id::uuid
          LIMIT ${COVERAGE_STORED_COUNT_CAP}
        ) capped
      ) held ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS added_last_week
        FROM case_law_decisions d
        WHERE d.source_id = named.source_id::uuid
          AND d.created_at >= ${sinceWeek}::timestamptz
          AND ${published}
      ) recent ON true
      ORDER BY named.ordinality
    `);
    if (previousTimeout !== null) {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${previousTimeout}, true)`,
      );
    }

    return new Map(
      rowsOf(result).flatMap((row) => {
        const sourceId = row["source_id"];
        if (typeof sourceId !== "string") {
          return [];
        }
        const stored = toCount(row["stored"]);
        return [
          [
            sourceId,
            {
              stored,
              capped: stored >= COVERAGE_STORED_COUNT_CAP,
              addedLastWeek: toCount(row["added_last_week"]),
            },
          ],
        ] as const;
      }),
    );
  },
);
