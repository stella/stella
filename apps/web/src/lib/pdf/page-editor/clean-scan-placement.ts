import { targetPageBox } from "@stll/scan-engine/review";
import type { TargetPageBox } from "@stll/scan-engine/review";
import type {
  CleanedScanImage,
  PhysicalPageSize,
  ScanPageRotation,
} from "@stll/scan-engine/types";

const POINTS_PER_INCH = 72;

/** A cleaned page image and the source page geometry it was rendered from. */
export type PageCleanScan = {
  image: CleanedScanImage;
  /** The source page's unrotated size; the cleaned page keeps it. */
  pageSize: PhysicalPageSize;
  /** Resolution the source page was rasterized at before cleaning. */
  dpi: number;
};

type CleanScanPlacement = {
  box: TargetPageBox;
  /** Where the image is drawn on the unrotated page, in points from the lower-left corner. */
  image: { x: number; y: number; width: number; height: number };
};

/**
 * Place a cleaned image on a page of the source page's physical size and the
 * page's current rotation. The image keeps its scanned physical size, so text
 * stays the size it was printed at; only an image that deskewing grew past the
 * page is scaled down to fit. It is centred because content cropping drops
 * the margins that located it.
 */
export const placeCleanScan = (
  scan: PageCleanScan,
  rotation: ScanPageRotation,
): CleanScanPlacement => {
  const box = targetPageBox(scan.pageSize, rotation);
  const naturalWidth = (scan.image.width / scan.dpi) * POINTS_PER_INCH;
  const naturalHeight = (scan.image.height / scan.dpi) * POINTS_PER_INCH;
  const scale = Math.min(
    1,
    box.widthPoints / naturalWidth,
    box.heightPoints / naturalHeight,
  );
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    box,
    image: {
      x: (box.widthPoints - width) / 2,
      y: (box.heightPoints - height) / 2,
      width,
      height,
    },
  };
};
