import { Result } from "better-result";

import type {
  RasterizedScanPage,
  ScanCornerSuggestion,
  ScanQuad,
} from "./types";
import { ScanEngineError } from "./types";

const readScanQuad = (
  values: Float32Array,
): Result<ScanQuad, ScanEngineError> => {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = values;
  if (
    values.length !== 8 ||
    x0 === undefined ||
    y0 === undefined ||
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    x3 === undefined ||
    y3 === undefined ||
    values.some((value) => !Number.isFinite(value))
  ) {
    return Result.err(
      new ScanEngineError({
        type: "engine-failure",
        message: "The scan engine returned an invalid page quadrilateral",
      }),
    );
  }
  return Result.ok({
    topLeft: { x: x0, y: y0 },
    topRight: { x: x1, y: y1 },
    bottomRight: { x: x2, y: y2 },
    bottomLeft: { x: x3, y: y3 },
  });
};

export const readAppliedScanQuad = (
  values: Float32Array,
): Result<ScanQuad | null, ScanEngineError> =>
  values.length === 0 ? Result.ok(null) : readScanQuad(values);

export const scanCornerSuggestion = (
  values: Float32Array,
  page: Pick<RasterizedScanPage, "width" | "height">,
): Result<ScanCornerSuggestion, ScanEngineError> => {
  if (values.length > 0) {
    return readScanQuad(values).map((corners) => ({
      type: "detected",
      corners,
    }));
  }
  return readScanQuad(
    new Float32Array([
      0,
      0,
      page.width - 1,
      0,
      page.width - 1,
      page.height - 1,
      0,
      page.height - 1,
    ]),
  ).map((corners) => ({ type: "full-frame", corners }));
};
export const writeScanQuad = (corners?: ScanQuad): Float32Array =>
  corners === undefined
    ? new Float32Array()
    : new Float32Array([
        corners.topLeft.x,
        corners.topLeft.y,
        corners.topRight.x,
        corners.topRight.y,
        corners.bottomRight.x,
        corners.bottomRight.y,
        corners.bottomLeft.x,
        corners.bottomLeft.y,
      ]);
