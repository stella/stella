import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";

import { documentProcessingRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

export type OcrDerivativeRun = {
  createdAt: Date;
  id: SafeId<"documentProcessingRun">;
};

export type OcrDerivativeCursor = OcrDerivativeRun;

/**
 * Total order every derivative page walk reads in: newest first, ties broken by
 * ascending id. Runs created in the same transaction share a `createdAt`, so
 * without the id tiebreaker a page boundary landing inside such a group would
 * skip or repeat its members.
 */
export const ocrDerivativePageOrder = () =>
  [
    desc(documentProcessingRuns.createdAt),
    asc(documentProcessingRuns.id),
  ] as const;

/** Keyset predicate for the rows strictly after `cursor` in that order. */
export const ocrDerivativeCursorFilter = (
  cursor: OcrDerivativeCursor | null,
): SQL | undefined =>
  cursor === null
    ? undefined
    : or(
        lt(documentProcessingRuns.createdAt, cursor.createdAt),
        and(
          eq(documentProcessingRuns.createdAt, cursor.createdAt),
          gt(documentProcessingRuns.id, cursor.id),
        ),
      );

/**
 * In-memory twin of `ocrDerivativeCursorFilter`, kept beside it so the walk's
 * exactly-once invariant is testable without a database. Change both together.
 */
export const isAfterOcrDerivativeCursor = (
  run: OcrDerivativeRun,
  cursor: OcrDerivativeCursor | null,
): boolean => {
  if (cursor === null) {
    return true;
  }
  if (run.createdAt.getTime() !== cursor.createdAt.getTime()) {
    return run.createdAt.getTime() < cursor.createdAt.getTime();
  }
  return run.id > cursor.id;
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

  await forEachOcrDerivativePage({ cursor: lastRun, onPage, readPage });
};
