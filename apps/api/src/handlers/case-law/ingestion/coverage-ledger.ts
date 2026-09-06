/**
 * Crawl-coverage ledger.
 *
 * A crawl that stops early is indistinguishable from a slice that simply
 * held fewer decisions, and a forward-only cursor never revisits, so the
 * shortfall is invisible and permanent. Recording the source's own count
 * for a slice next to what the crawl produced turns that into a row the
 * reconciliation pass can select on.
 *
 * The write is an upsert keyed on (source, slice): re-crawling a slice
 * replaces its counts rather than accumulating, so the ledger always
 * describes the latest attempt.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCoverageSlices } from "@/api/db/schema";
import type { SliceCoverage } from "@/api/handlers/case-law/ingestion/adapter";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

export type RecordSliceCoverageInput = {
  sourceId: SafeId<"caseLawSource">;
  coverage: SliceCoverage;
};

export const recordSliceCoverage = async (
  scopedDb: ScopedDb,
  { sourceId, coverage }: RecordSliceCoverageInput,
): Promise<void> => {
  await scopedDb(async (tx) => {
    // audit: skip — crawl bookkeeping, not a user action
    await tx
      .insert(caseLawCoverageSlices)
      .values({
        id: createSafeId<"caseLawCoverageSlice">(),
        sourceId,
        slice: coverage.slice,
        reported: coverage.reported,
        collected: coverage.collected,
      })
      .onConflictDoUpdate({
        target: [caseLawCoverageSlices.sourceId, caseLawCoverageSlices.slice],
        set: {
          reported: coverage.reported,
          collected: coverage.collected,
          checkedAt: sql`now()`,
          // A slice that lists again is no longer failed, whatever it was.
          walkError: null,
        },
      });
  });
};

export type TouchSliceCoveragesInput = {
  sourceId: SafeId<"caseLawSource">;
  slices: readonly string[];
};

/**
 * Re-stamp counted rows' `checkedAt` without touching what they say.
 *
 * Bookkeeping outside the source lease, so it must not overwrite what a
 * leased walk on another replica may have recorded since the rows were read:
 * the counts stay, and a row that has meanwhile failed is left to the retry
 * arm rather than quietly restored to counted.
 */
export const touchSliceCoverages = async (
  scopedDb: ScopedDb,
  { slices, sourceId }: TouchSliceCoveragesInput,
): Promise<void> => {
  if (slices.length === 0) {
    return;
  }
  await scopedDb(async (tx) => {
    // audit: skip — crawl bookkeeping, not a user action
    await tx
      .update(caseLawCoverageSlices)
      .set({ checkedAt: sql`now()` })
      .where(
        and(
          eq(caseLawCoverageSlices.sourceId, sourceId),
          inArray(caseLawCoverageSlices.slice, [...slices]),
          isNull(caseLawCoverageSlices.walkError),
        ),
      );
  });
};

export type RecordSliceWalkFailureInput = {
  sourceId: SafeId<"caseLawSource">;
  slice: string;
  /** Why the walk failed, as the retry arm and an operator will read it. */
  walkError: string;
};

/**
 * Record that a slice's listing walk failed.
 *
 * Without a row a failed slice is indistinguishable from one never surveyed,
 * and the historical sweep, which fills downward from the newest surveyed
 * slice, would hand it back on every turn and never move past it. The row
 * keeps whatever counts an earlier walk recorded and stamps `checkedAt`, so
 * the failed slice leaves the sweep's frontier and the short backlog's stale
 * window alike and is owned by the retry arm until a walk lists it again.
 */
export const recordSliceWalkFailure = async (
  scopedDb: ScopedDb,
  { slice, sourceId, walkError }: RecordSliceWalkFailureInput,
): Promise<void> => {
  await scopedDb(async (tx) => {
    // audit: skip — crawl bookkeeping, not a user action
    await tx
      .insert(caseLawCoverageSlices)
      .values({
        id: createSafeId<"caseLawCoverageSlice">(),
        sourceId,
        slice,
        reported: null,
        collected: null,
        walkError,
      })
      .onConflictDoUpdate({
        target: [caseLawCoverageSlices.sourceId, caseLawCoverageSlices.slice],
        set: { walkError, checkedAt: sql`now()` },
      });
  });
};
