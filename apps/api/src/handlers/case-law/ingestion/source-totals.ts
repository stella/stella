import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";

/**
 * The count a publisher reports holding, per source. Held-vs-total coverage
 * needs a total, and several publishers expose none cheaply, so the number is
 * persisted rather than recomputed: polled from the adapter where one
 * implements `getTotalCount`, supplied by an operator where none does.
 *
 * This module is the only writer of the trio. It is what keeps
 * `reportedTotal`, `reportedTotalAsOf` and `reportedTotalOrigin` in the "all
 * set" state — the columns are nullable so a source that has never been
 * measured reads as unknown rather than as zero.
 */

/**
 * The sources table holds one row per registered adapter key, a set fixed in
 * code. The bound is the lint-visible statement of that.
 */
const SOURCE_READ_LIMIT = 100;

type SetSourceReportedTotalOptions = {
  scopedDb: ScopedDb;
  adapterKey: string;
  total: number;
  asOf: Date;
  origin: SourceTotalOrigin;
};

export type SourceReportedTotal = {
  adapterKey: string;
  reportedTotal: number | null;
  reportedTotalAsOf: Date | null;
  reportedTotalOrigin: SourceTotalOrigin | null;
};

/**
 * Record what a publisher reports holding for one source.
 *
 * A total of zero or below is rejected rather than stored: no publisher this
 * runs against reports holding nothing, so such a value is a caller bug (a
 * parse that yielded NaN, a failed poll coerced to a number) and storing it
 * would read downstream as complete coverage of an empty corpus.
 *
 * Returns false when no source carries `adapterKey`.
 */
export const setSourceReportedTotal = async ({
  scopedDb,
  adapterKey,
  total,
  asOf,
  origin,
}: SetSourceReportedTotalOptions): Promise<boolean> => {
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new TypeError(
      `reported total must be a positive safe integer, got: ${total}`,
    );
  }
  if (Number.isNaN(asOf.getTime())) {
    throw new TypeError("reported total asOf must be a valid date");
  }

  return await scopedDb(async (tx) => {
    // audit: skip — public case-law corpus bookkeeping, no workspace data
    const updated = await tx
      .update(caseLawSources)
      .set({
        reportedTotal: total,
        reportedTotalAsOf: asOf,
        reportedTotalOrigin: origin,
      })
      .where(eq(caseLawSources.adapterKey, adapterKey))
      .returning({ adapterKey: caseLawSources.adapterKey });

    return updated.length > 0;
  });
};

/** Every source's reported total, for coverage reporting. */
export const readSourceReportedTotals = async (
  scopedDb: ScopedDb,
): Promise<SourceReportedTotal[]> =>
  await scopedDb(
    async (tx) =>
      await tx
        .select({
          adapterKey: caseLawSources.adapterKey,
          reportedTotal: caseLawSources.reportedTotal,
          reportedTotalAsOf: caseLawSources.reportedTotalAsOf,
          reportedTotalOrigin: caseLawSources.reportedTotalOrigin,
        })
        .from(caseLawSources)
        .orderBy(caseLawSources.adapterKey)
        .limit(SOURCE_READ_LIMIT),
  );
