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

import { sql } from "drizzle-orm";

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
        },
      });
  });
};
