import { panic } from "better-result";
import { sql, type SQLWrapper } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawSourceArrivals } from "@/api/db/schema";
import { SOURCE_ARRIVALS_WINDOW_MS } from "@/api/lib/case-law/source-arrivals-window";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";

/** The connection the scheduler task opens; the refresh owns its transaction. */
type RefreshDb = {
  transaction: <Value>(
    run: (tx: Transaction) => Promise<Value>,
  ) => Promise<Value>;
};

/**
 * One source's published arrivals in `[since, until)`.
 *
 * `case_law_decisions_source_arrivals_published_idx` is `(source_id, created_at)`,
 * partial on the publication gate, so the window is an index range and is
 * counted off the index. It still visits the heap for every page not yet
 * marked all-visible, and a week of bulk ingest is exactly the freshly
 * written, not yet vacuumed range: seconds on a busy week, which is why the
 * count runs on the scheduler and never on a public request. The upper bound
 * is the stored `counted_at`, so the week a row states is the week it counted.
 * The ingestion invariant counts a day through the same statement, so both
 * read the window off the same index range.
 */
export const sourceArrivalsCountSql = ({
  since,
  sourceId,
  until,
}: {
  since: Date;
  /** The outer query's source id column the count correlates with. */
  sourceId: SQLWrapper;
  until: Date;
}) =>
  // sql-perf-allow: index case_law_decisions_source_arrivals_published_idx, one created_at range per source
  sql`
  SELECT count(*)::integer AS added_last_week
  FROM case_law_published_decisions d
  WHERE d.source_id = ${sourceId}
    AND d.created_at >= ${since.toISOString()}::timestamptz
    AND d.created_at < ${until.toISOString()}::timestamptz
`;

/** The refresh input for every source, as one statement the plan guard checks. */
export const sourceArrivalsRefreshQuery = (now: Date) => sql`
  SELECT s.id AS source_id, recent.added_last_week
  FROM case_law_sources s
  CROSS JOIN LATERAL (${sourceArrivalsCountSql({
    since: new Date(now.getTime() - SOURCE_ARRIVALS_WINDOW_MS),
    sourceId: sql`s.id`,
    until: now,
  })}) AS recent
`;

/**
 * Replace every source's weekly arrivals atomically. Every source is counted,
 * withheld ones included: the reader's row policy decides what is published,
 * so a policy change takes effect on the next read, not the next refresh.
 */
export const refreshCaseLawSourceArrivals = async (
  db: RefreshDb,
  { now, signal }: { now: Date; signal?: AbortSignal },
) =>
  await withAggregateTransaction(db, async (tx) => {
    await tx.delete(caseLawSourceArrivals).where(sql`true`);
    await tx.execute(sql`
      INSERT INTO ${caseLawSourceArrivals}
        (source_id, added_last_week, counted_at)
      SELECT source_id, added_last_week, ${now.toISOString()}::timestamptz
      FROM (${sourceArrivalsRefreshQuery(now)}) AS counted
    `);

    const [summary] = await tx
      .select({ sources: sql<number>`count(*)::int` })
      .from(caseLawSourceArrivals);
    if (!summary) {
      panic("Source arrivals refresh aggregate returned no row.");
    }
    signal?.throwIfAborted();
    return { sources: summary.sources };
  });
