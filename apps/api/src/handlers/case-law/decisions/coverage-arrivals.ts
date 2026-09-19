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
 * What became public for each source in the last seven days.
 *
 * This is the only read the coverage page makes against the decisions table,
 * and it is bounded by a week of one source's arrivals rather than by the
 * corpus: `case_law_decisions_source_generation_cursor_idx` leads with
 * `source_id` and then `created_at`, so the window is an index range the
 * planner enters at its lower bound. How much a source holds in total is not
 * asked here at all — that figure is counted on the ingestion connection and
 * read back as an integer (`ingestion/source-totals.ts`), because counting it
 * per request would put a walk of the whole range on a two-connection pool.
 *
 * The window carries `publishedCaseLawDecisionSqlFor` like every other public
 * read: "what arrived" is a claim about the corpus a reader can actually see,
 * so an identity the publisher listed but never served is not in it.
 */

const WEEK_IN_MS = 7 * DAY_IN_MS;

/**
 * How long the window read may run.
 *
 * The same bound `status-courts.ts` puts on its per-court probes, and for the
 * same reason: warm this is an index range and runs in milliseconds, so a
 * value this far above that is what turns a cold or missing index into a fast,
 * visible degradation instead of a public page stalled on a shared pool.
 */
const ARRIVALS_STATEMENT_TIMEOUT = "3s";

export type CaseLawSourceArrivals = {
  /** Decisions published for the source in the last seven days. */
  addedLastWeek: number;
};

type ArrivalsRead = {
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

export const readCaseLawArrivalsQuery = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawCoverageArrivals,
  async (
    tx: CaseLawPublicReadTransaction,
    { now, sourceIds }: ArrivalsRead,
  ): Promise<ReadonlyMap<string, CaseLawSourceArrivals>> => {
    if (sourceIds.length === 0) {
      return new Map();
    }
    const sinceWeek = new Date(now.getTime() - WEEK_IN_MS);
    const published = sql.raw(publishedCaseLawDecisionSqlFor("d"));

    // Transaction-local and handed back below: the coverage read is one of
    // several this transaction runs, and the next of them must not inherit
    // this bound. `set_config(..., true)` reverts with the transaction, so a
    // cancelled statement needs no unwinding of its own.
    const previousTimeout = await readStatementTimeout(tx);
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${ARRIVALS_STATEMENT_TIMEOUT}, true)`,
    );

    const result: unknown = await tx.execute(sql`
      SELECT
        named.source_id AS source_id,
        recent.added_last_week AS added_last_week
      FROM jsonb_array_elements_text(${JSON.stringify([...sourceIds])}::text::jsonb)
        WITH ORDINALITY AS named(source_id, ordinality)
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
        return [
          [sourceId, { addedLastWeek: toCount(row["added_last_week"]) }],
        ] as const;
      }),
    );
  },
);
