import type { Result } from "better-result";
import { TaggedError } from "better-result";

export type ScanPageRotation = 0 | 90 | 180 | 270;

export type PhysicalPageSize = {
  widthPoints: number;
  heightPoints: number;
};

export type RasterizedScanPage = {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  pageSize: PhysicalPageSize;
  dpi: number;
  rotation: ScanPageRotation;
};

export type ScanOptions = {
  output: "grayscale" | "binary";
  contentCrop: "on" | "off";
  deskew: "on" | "off";
  corners?: ScanQuad;
};

/** Source-raster pixel coordinates, clockwise from the top-left corner. */
export type ScanQuad = {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
};

export type ScanCornerSuggestion =
  | { type: "detected"; corners: ScanQuad }
  | { type: "full-frame"; corners: ScanQuad };

export type ContentBox = {
  /** Bounds of the detected content in the returned output image. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CleanedScanImage = {
  pixels: Uint8Array;
  /** Deskewing expands these dimensions to contain the complete rotated page. */
  width: number;
  height: number;
  format: ScanOptions["output"];
};

export type CleanScanResult =
  | {
      type: "cleaned";
      image: CleanedScanImage;
      /** Corners used to clean the input image, clockwise from top-left. */
      appliedQuad: ScanQuad | null;
      skewDegrees: number;
      contentBox: ContentBox;
    }
  | { type: "unrecognized"; reason: string };

export class ScanEngineError extends TaggedError("ScanEngineError")<{
  type: "engine-failure" | "engine-timeout";
  message: string;
  cause?: unknown;
}> {}

export type ScanEngine = {
  detect: (
    page: RasterizedScanPage,
  ) => Promise<Result<ScanCornerSuggestion, ScanEngineError>>;
  clean: (
    page: RasterizedScanPage,
    options: ScanOptions,
  ) => Promise<Result<CleanScanResult, ScanEngineError>>;
};
