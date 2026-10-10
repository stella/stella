import type { Result } from "better-result";
import { TaggedError } from "better-result";

export type PageRotation = 0 | 90 | 180 | 270;

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
  rotation: PageRotation;
};

export type ScanOptions = {
  output: "grayscale" | "binary";
  contentCrop: "on" | "off";
  deskew: "on" | "off";
};

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

export type ScanResult =
  | {
      type: "cleaned";
      image: CleanedScanImage;
      /** Corners of the detected page in the input image, clockwise from top-left. */
      appliedQuad: {
        topLeft: { x: number; y: number };
        topRight: { x: number; y: number };
        bottomRight: { x: number; y: number };
        bottomLeft: { x: number; y: number };
      } | null;
      skewDegrees: number;
      contentBox: ContentBox;
    }
  | { type: "unrecognized"; reason: string };

export class ScanEngineError extends TaggedError("ScanEngineError")<{
  message: string;
  cause?: unknown;
}> {}

export type ScanEngine = {
  clean: (
    page: RasterizedScanPage,
    options: ScanOptions,
  ) => Promise<Result<ScanResult, ScanEngineError>>;
};
