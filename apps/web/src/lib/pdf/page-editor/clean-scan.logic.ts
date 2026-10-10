import { panic, Result } from "better-result";

import type {
  PageRotation,
  PhysicalPageSize,
  RasterizedScanPage,
  ScanEngine,
  ScanEngineError,
  ScanOptions,
  ScanResult,
} from "./scan-engine";

type CleanedScan = Extract<ScanResult, { type: "cleaned" }>;

export type CleanScanPageReview =
  | { type: "pending"; pageId: string }
  | { type: "preview"; pageId: string; scan: CleanedScan }
  | { type: "applied"; pageId: string; scan: CleanedScan }
  | { type: "rejected"; pageId: string; scan: CleanedScan }
  | { type: "unrecognized"; pageId: string; reason: string };

export type CleanScanReview = {
  pages: readonly CleanScanPageReview[];
  past: readonly (readonly CleanScanPageReview[])[];
};

type ReviewPageOptions = {
  engine: ScanEngine;
  pageId: string;
  page: RasterizedScanPage;
  options: ScanOptions;
};

export const reviewPage = async ({
  engine,
  pageId,
  page,
  options,
}: ReviewPageOptions): Promise<
  Result<CleanScanPageReview, ScanEngineError>
> => {
  const result = await engine.clean(page, options);
  if (result.isErr()) {
    return Result.err(result.error);
  }
  switch (result.value.type) {
    case "cleaned":
      return Result.ok({ type: "preview", pageId, scan: result.value });
    case "unrecognized":
      return Result.ok({
        type: "unrecognized",
        pageId,
        reason: result.value.reason,
      });
    default:
      return panic("Unhandled scan result", result.value satisfies never);
  }
};

export const createCleanScanReview = (
  pageIds: readonly string[],
): CleanScanReview => ({
  pages: pageIds.map((pageId) => ({ type: "pending", pageId })),
  past: [],
});

const applyPage = (page: CleanScanPageReview): CleanScanPageReview => {
  switch (page.type) {
    case "preview":
      return { type: "applied", pageId: page.pageId, scan: page.scan };
    case "pending":
    case "applied":
    case "rejected":
    case "unrecognized":
      return page;
    default:
      return panic("Unhandled clean scan review state", page satisfies never);
  }
};

const recordTransition = (
  review: CleanScanReview,
  pages: readonly CleanScanPageReview[],
): CleanScanReview => {
  if (pages.every((page, index) => page === review.pages[index])) {
    return review;
  }
  return { pages, past: [...review.past, review.pages] };
};

export const applyOne = (
  review: CleanScanReview,
  pageId: string,
): CleanScanReview =>
  recordTransition(
    review,
    review.pages.map((page) =>
      page.pageId === pageId ? applyPage(page) : page,
    ),
  );

export const applyAll = (review: CleanScanReview): CleanScanReview =>
  recordTransition(review, review.pages.map(applyPage));

export const undoCleanScanReview = (
  review: CleanScanReview,
): CleanScanReview => {
  const pages = review.past.at(-1);
  if (!pages) {
    return review;
  }
  return { pages, past: review.past.slice(0, -1) };
};

export type TargetPageBox = PhysicalPageSize & {
  xPoints: 0;
  yPoints: 0;
  rotation: PageRotation;
};

export const targetPageBox = (
  pageSize: PhysicalPageSize,
  rotation: PageRotation,
): TargetPageBox => ({
  xPoints: 0,
  yPoints: 0,
  widthPoints: pageSize.widthPoints,
  heightPoints: pageSize.heightPoints,
  rotation,
});
