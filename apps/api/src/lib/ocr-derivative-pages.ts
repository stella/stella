import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";

import { documentProcessingRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

export type OcrDerivativeRun = {
  id: SafeId<"documentProcessingRun">;
};

/**
 * The previous page's last run. Only its id travels: the boundary's
 * `created_at` is read back in the database, so the comparison stays at the
 * column's microsecond precision. Carrying a JS `Date` instead truncates it
 * to the millisecond, and the descending `<` boundary then skips every run
 * inside the truncated sliver — whose searchable-PDF objects would be left
 * in the bucket after the matter or entity that owned them is deleted.
 */
export type OcrDerivativeCursor = SafeId<"documentProcessingRun">;

/**
 * Total order every derivative page walk reads in: newest first, ties broken by
 * ascending id, matching `document_processing_runs_workspace_created_idx`.
 * Runs created in the same transaction share a `createdAt`, so without the id
 * tiebreaker a page boundary landing inside such a group would skip or repeat
 * its members.
 */
export const ocrDerivativePageOrder = () =>
  [
    desc(documentProcessingRuns.createdAt),
    asc(documentProcessingRuns.id),
  ] as const;

/**
 * Keyset predicate for the rows strictly after `cursor` in that order. The
 * two key parts run in opposite directions, so this cannot be a row-tuple
 * comparison; the boundary's `created_at` is an uncorrelated scalar subquery
 * the planner evaluates once.
 */
export const ocrDerivativeCursorFilter = (
  cursor: OcrDerivativeCursor | null,
): SQL | undefined => {
  if (cursor === null) {
    return undefined;
  }
  const boundaryCreatedAt = sql`(select b.created_at from document_processing_runs b where b.id = ${cursor})`;
  return or(
    lt(documentProcessingRuns.createdAt, boundaryCreatedAt),
    and(
      eq(documentProcessingRuns.createdAt, boundaryCreatedAt),
      gt(documentProcessingRuns.id, cursor),
    ),
  );
};

type ForEachOcrDerivativePageOptions = {
  cursor?: OcrDerivativeCursor | null;
  onPage: (runs: OcrDerivativeRun[]) => Promise<void>;
  readPage: (
    cursor: OcrDerivativeCursor | null,
    limit: number,
  ) => Promise<OcrDerivativeRun[]>;
};

/**
 * Walks every OCR derivative of a deletion scope in bounded cursor pages.
 *
 * Recursion keeps the sequence explicit: a page is fully handled before its
 * cursor advances, so an interrupted walk restarts from the first deterministic
 * key instead of skipping a page. Callers never load an unbounded run set.
 */
export const forEachOcrDerivativePage = async ({
  cursor = null,
  onPage,
  readPage,
}: ForEachOcrDerivativePageOptions): Promise<void> => {
  const page = await readPage(cursor, LIMITS.ocrDerivativeCleanupBatchSize);
  if (page.length === 0) {
    return;
  }

  await onPage(page);
  if (page.length < LIMITS.ocrDerivativeCleanupBatchSize) {
    return;
  }

  const lastRun = page.at(-1);
  if (!lastRun) {
    return;
  }

  await forEachOcrDerivativePage({ cursor: lastRun.id, onPage, readPage });
};
