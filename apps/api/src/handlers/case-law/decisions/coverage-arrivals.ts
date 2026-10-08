import { and, inArray, sql } from "drizzle-orm";

import { caseLawSourceArrivals } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { SOURCE_ARRIVALS_FRESHNESS_MS } from "@/api/lib/case-law/source-arrivals-window";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

/**
 * What became public for each source in the last seven days, as the
 * scheduler last counted it (`lib/case-law/source-arrivals-refresh.ts`).
 *
 * The request never counts a week of arrivals itself: the window is a heap
 * walk of every decision a source received in it, which during a bulk ingest
 * is far more than a public read on a two-connection pool may hold a
 * connection for. It reads one stored integer per source instead, a primary
 * key lookup. Source policy is enforced by the reader's row policy on the
 * snapshot, so a withheld source has no row to return.
 *
 * A count older than `SOURCE_ARRIVALS_FRESHNESS_MS` describes a different
 * week, so it is not returned: the source reads as unknown, never as a stale
 * number presented as this week's.
 */

export type CaseLawSourceArrivals = {
  /** Decisions published for the source in the seven days before the count. */
  addedLastWeek: number;
};

type ArrivalsRead = {
  sourceIds: readonly SafeId<"caseLawSource">[];
  /** The instant the freshness of each stored count is judged against. */
  now: Date;
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
    const rows = await caseLawArrivalsSnapshotQuery(tx, { now, sourceIds });
    return new Map(
      rows.map(
        (row) =>
          [String(row.sourceId), { addedLastWeek: row.addedLastWeek }] as const,
      ),
    );
  },
);

/** The snapshot read itself, also registered with the query-plan guard. */
export const caseLawArrivalsSnapshotQuery = (
  tx: Pick<CaseLawPublicReadTransaction, "select">,
  { now, sourceIds }: ArrivalsRead,
) =>
  tx
    .select({
      sourceId: caseLawSourceArrivals.sourceId,
      addedLastWeek: caseLawSourceArrivals.addedLastWeek,
    })
    .from(caseLawSourceArrivals)
    .where(
      and(
        inArray(caseLawSourceArrivals.sourceId, [...sourceIds]),
        // A freshness cutoff, not a stored-row boundary: millisecond
        // precision is all the window means.
        sql`${caseLawSourceArrivals.countedAt} >= ${new Date(
          now.getTime() - SOURCE_ARRIVALS_FRESHNESS_MS,
        ).toISOString()}::timestamptz`,
      ),
    )
    .limit(sourceIds.length);
