import { Result, TaggedError } from "better-result";
import { and, eq, isNull, lt, or } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import { isoCalendarDay } from "@/api/lib/dates";
import { sourceRegistryMembership } from "@/api/lib/legal-search/source-registry-membership";

class ImportSnapshotError extends TaggedError("ImportSnapshotError")<{
  message: string;
}> {}

type RecordImportSnapshotOptions = {
  scopedDb: ScopedDb;
  adapterKey: string;
  /** The publisher snapshot the completed import read, as `YYYY-MM-DD`. */
  snapshotDate: string;
};

/**
 * Record the publisher snapshot a bulk import source has finished reading.
 *
 * Called once an import run completes, never per batch: a partly applied
 * snapshot is not the source's edition yet. The date only moves forward, so
 * a rerun of an older snapshot cannot make the page claim an older edition
 * than the corpus already holds.
 *
 * Resolves to `Ok(false)` when no source row carries `adapterKey`, or when it
 * already states this snapshot or a later one, and to `Err` when the key is
 * not a bulk import source or the date is not an ISO calendar day.
 */
export const recordImportSnapshot = async ({
  scopedDb,
  adapterKey,
  snapshotDate,
}: RecordImportSnapshotOptions): Promise<
  Result<boolean, ImportSnapshotError>
> => {
  if (sourceRegistryMembership(adapterKey).type !== "import") {
    return Result.err(
      new ImportSnapshotError({
        message: `not a bulk import source: ${adapterKey}`,
      }),
    );
  }
  if (isoCalendarDay(snapshotDate) !== snapshotDate) {
    return Result.err(
      new ImportSnapshotError({
        message: `import snapshot must be an ISO calendar day, got: ${snapshotDate}`,
      }),
    );
  }

  const recorded = await scopedDb(async (tx) => {
    // audit: skip — public case-law corpus bookkeeping, no workspace data
    const updated = await tx
      .update(caseLawSources)
      .set({ importSnapshotDate: snapshotDate })
      .where(
        and(
          eq(caseLawSources.adapterKey, adapterKey),
          or(
            isNull(caseLawSources.importSnapshotDate),
            lt(caseLawSources.importSnapshotDate, snapshotDate),
          ),
        ),
      )
      .returning({ id: caseLawSources.id });
    return updated.length > 0;
  });
  return Result.ok(recorded);
};
