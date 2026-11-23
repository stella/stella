/**
 * What one PDF render may use, derived from the memory its container has.
 *
 * The render worker is a child of the process that asks for the render and
 * shares that process's container limit. Its memory ceiling is what the
 * container has left once the parent's current RSS, the PDF the parent will
 * read back, and room for the parent to grow are set aside, never more than
 * `LIMITS.pdfRenderWorkerRssMaxBytes`. The source budgets scale with the
 * ceiling: at the cap they are the `LIMITS` values, and below it each
 * shrinks to the share of the cap's room that is left, room being a
 * ceiling less a started worker's own memory and a margin. Below
 * `LIMITS.pdfRenderWorkerRssMinBytes`
 * there is no budget, and the render waits for another time instead of
 * risking the container.
 */

import * as v from "valibot";

import { LIMITS } from "@/api/lib/limits";
import type { ProcessMemoryLimit } from "@/api/lib/observability/process-memory-limit";

export type PdfRenderBudget = {
  /** The worker's resident-memory ceiling. */
  workerRssMaxBytes: number;
  textSourceBytesMax: number;
  textPagesMax: number;
  textPagesPerFontRun: number;
  imageDecodedBytesMax: number;
  imagePixelsMax: number;
  tiffPageDecodedBytesMax: number;
  imagePagesMax: number;
};

/** The budget at the cap: the `LIMITS` values themselves. */
export const FULL_PDF_RENDER_BUDGET = {
  workerRssMaxBytes: LIMITS.pdfRenderWorkerRssMaxBytes,
  textSourceBytesMax: LIMITS.pdfRenderTextSourceBytesMax,
  textPagesMax: LIMITS.pdfRenderTextPagesMax,
  textPagesPerFontRun: LIMITS.pdfRenderTextPagesPerFontRun,
  imageDecodedBytesMax: LIMITS.pdfRenderImageDecodedBytesMax,
  imagePixelsMax: LIMITS.pdfRenderImagePixelsMax,
  tiffPageDecodedBytesMax: LIMITS.pdfRenderTiffPageDecodedBytesMax,
  imagePagesMax: LIMITS.pdfRenderImagePagesMax,
} as const satisfies PdfRenderBudget;

const positiveInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/** A budget as the worker receives it, on its command line. */
export const pdfRenderBudgetSchema = v.strictObject({
  workerRssMaxBytes: positiveInteger,
  textSourceBytesMax: positiveInteger,
  textPagesMax: positiveInteger,
  textPagesPerFontRun: positiveInteger,
  imageDecodedBytesMax: positiveInteger,
  imagePixelsMax: positiveInteger,
  tiffPageDecodedBytesMax: positiveInteger,
  imagePagesMax: positiveInteger,
}) satisfies v.GenericSchema<PdfRenderBudget>;

/**
 * The budget for a render started now, or `null` when the container has too
 * little memory left for one.
 */
export const pdfRenderBudget = ({
  limit,
  parentRssBytes,
}: {
  /** The container's limit, as `readProcessMemoryLimit` reads it. */
  limit: ProcessMemoryLimit;
  /** The parent's resident memory as the render starts. */
  parentRssBytes: number;
}): PdfRenderBudget | null => {
  const cap = LIMITS.pdfRenderWorkerRssMaxBytes;
  const ceiling =
    limit.type === "limited"
      ? Math.min(
          cap,
          limit.bytes -
            parentRssBytes -
            LIMITS.fileDerivativePdfMaxBytes -
            LIMITS.pdfRenderParentGrowthBytes,
        )
      : cap;
  if (ceiling < LIMITS.pdfRenderWorkerRssMinBytes) {
    return null;
  }
  // The room a ceiling gives sources: above a started worker's own memory,
  // less the margin kept below it.
  const room = (rss: number) =>
    rss -
    LIMITS.pdfRenderWorkerBaseRssBytes -
    LIMITS.pdfRenderWorkerMarginBytes;
  const share = room(ceiling) / room(cap);
  const scaled = (full: number) => Math.max(1, Math.floor(full * share));
  return {
    workerRssMaxBytes: Math.floor(ceiling),
    textSourceBytesMax: scaled(FULL_PDF_RENDER_BUDGET.textSourceBytesMax),
    textPagesMax: scaled(FULL_PDF_RENDER_BUDGET.textPagesMax),
    textPagesPerFontRun: scaled(FULL_PDF_RENDER_BUDGET.textPagesPerFontRun),
    imageDecodedBytesMax: scaled(FULL_PDF_RENDER_BUDGET.imageDecodedBytesMax),
    imagePixelsMax: scaled(FULL_PDF_RENDER_BUDGET.imagePixelsMax),
    tiffPageDecodedBytesMax: scaled(
      FULL_PDF_RENDER_BUDGET.tiffPageDecodedBytesMax,
    ),
    imagePagesMax: scaled(FULL_PDF_RENDER_BUDGET.imagePagesMax),
  };
};
