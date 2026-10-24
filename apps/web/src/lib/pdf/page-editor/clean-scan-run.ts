import { Result } from "better-result";

import { reviewPage } from "@stll/scan-engine/review";
import type { CleanScanPageReview } from "@stll/scan-engine/review";
import type {
  RasterizedScanPage,
  ScanEngine,
  ScanOptions,
  ScanPageRotation,
} from "@stll/scan-engine/types";

import { ClientOperationError } from "@/lib/errors/client";
import type { PDFPageProxy } from "@/lib/pdf/pdfjs-loader";

import type { PageCleanScan } from "./clean-scan-placement";

/**
 * Rasterizing resolution: enough for the engine to find page edges and text
 * baselines on letter and A4 pages while keeping each request well inside
 * the engine's per-page time limit.
 */
const CLEAN_SCAN_DPI = 150;
const POINTS_PER_INCH = 72;

export type CleanScanGeometry = Omit<PageCleanScan, "image">;

/** Why a page under review has no result: it stays pending and untouched. */
export type CleanScanFailure = {
  pageId: string;
  reason: "engine-failure" | "engine-timeout" | "render-failure";
  message: string;
};

type RasterizeScanPageOptions = {
  proxy: Pick<PDFPageProxy, "getViewport" | "render">;
  rotation: ScanPageRotation;
};

/**
 * Render the source page unrotated, so the cleaned image lines up with the
 * page box it replaces and the organizer's rotation still applies on top.
 */
const rasterizeScanPage = async ({
  proxy,
  rotation,
}: RasterizeScanPageOptions): Promise<RasterizedScanPage> => {
  const scale = CLEAN_SCAN_DPI / POINTS_PER_INCH;
  const viewport = proxy.getViewport({ rotation: 0, scale });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    await proxy.render({ canvas, viewport }).promise;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new ClientOperationError({
        action: "clean-scan-render",
        message: "The page could not be drawn for cleaning",
      });
    }
    return {
      pixels: context.getImageData(0, 0, width, height).data,
      width,
      height,
      pageSize: {
        widthPoints: viewport.width / scale,
        heightPoints: viewport.height / scale,
      },
      dpi: CLEAN_SCAN_DPI,
      rotation,
    };
  } finally {
    // Release the backing store at once; a long run would otherwise hold
    // one full-resolution canvas per page until collection.
    canvas.width = 0;
    canvas.height = 0;
  }
};

type CleanScanRunPage = RasterizeScanPageOptions & { pageId: string };

type RunCleanScanOptions = {
  engine: ScanEngine;
  options: ScanOptions;
  pages: readonly CleanScanRunPage[];
  signal: AbortSignal;
  onFailed: (failure: CleanScanFailure) => void;
  onReviewed: (
    review: CleanScanPageReview,
    geometry: CleanScanGeometry,
  ) => void;
};

/**
 * Clean pages one at a time, reporting each outcome as it lands. Pages run
 * in sequence because the engine serializes requests anyway and each raster
 * holds a full page of RGBA pixels. A failure is reported for its page and
 * the run moves on; an aborted run reports nothing further.
 */
export const runCleanScan = async (
  { engine, options, pages, signal, onFailed, onReviewed }: RunCleanScanOptions,
  index = 0,
): Promise<void> => {
  const page = pages.at(index);
  if (page === undefined || signal.aborted) {
    return;
  }
  const raster = await Result.tryPromise({
    try: async () => await rasterizeScanPage(page),
    catch: (cause) =>
      cause instanceof Error ? cause.message : "The page could not be drawn",
  });
  if (signal.aborted) {
    return;
  }
  if (Result.isError(raster)) {
    onFailed({
      pageId: page.pageId,
      reason: "render-failure",
      message: raster.error,
    });
  } else {
    const reviewed = await reviewPage({
      engine,
      pageId: page.pageId,
      page: raster.value,
      options,
    });
    if (signal.aborted) {
      return;
    }
    if (Result.isError(reviewed)) {
      onFailed({
        pageId: page.pageId,
        reason: reviewed.error.type,
        message: reviewed.error.message,
      });
    } else {
      onReviewed(reviewed.value, {
        pageSize: raster.value.pageSize,
        dpi: raster.value.dpi,
      });
    }
  }
  await runCleanScan(
    { engine, options, pages, signal, onFailed, onReviewed },
    index + 1,
  );
};
