import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

export type OcrDerivativeRun = {
  createdAt: Date;
  id: SafeId<"documentProcessingRun">;
};

export type OcrDerivativeCursor = OcrDerivativeRun;

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
