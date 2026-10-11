import type { ScanQuad } from "@stll/scan-engine/types";

import type { BoxDragAdjustment } from "@/hooks/use-box-drag";

export type ScanCorner = keyof ScanQuad;

export const fullPageScanCorners = (
  width: number,
  height: number,
): ScanQuad => ({
  topLeft: { x: 0, y: 0 },
  topRight: { x: width - 1, y: 0 },
  bottomRight: { x: width - 1, y: height - 1 },
  bottomLeft: { x: 0, y: height - 1 },
});

type MoveScanCornerOptions = {
  corners: ScanQuad;
  corner: ScanCorner;
  delta: { x: number; y: number };
  width: number;
  height: number;
};

/** Reject crossings and collapsed edges instead of changing other handles. */
export const moveScanCorner = ({
  corners,
  corner,
  delta,
  width,
  height,
}: MoveScanCornerOptions): ScanQuad => {
  const current = corners[corner];
  const next = {
    ...corners,
    [corner]: {
      x: Math.min(width - 1, Math.max(0, current.x + delta.x)),
      y: Math.min(height - 1, Math.max(0, current.y + delta.y)),
    },
  };
  const { topLeft, topRight, bottomRight, bottomLeft } = next;
  const turns = [
    [topLeft, topRight, bottomRight],
    [topRight, bottomRight, bottomLeft],
    [bottomRight, bottomLeft, topLeft],
    [bottomLeft, topLeft, topRight],
  ] as const;
  for (const [a, b, c] of turns) {
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) {
      return corners;
    }
  }
  return next;
};

type DragScanCornerOptions = BoxDragAdjustment<ScanQuad, ScanCorner> & {
  width: number;
  height: number;
};

export const dragScanCorner = ({
  box,
  mode,
  delta,
  width,
  height,
}: DragScanCornerOptions): ScanQuad =>
  moveScanCorner({
    corners: box,
    corner: mode,
    delta: { x: delta.x * (width - 1), y: delta.y * (height - 1) },
    width,
    height,
  });
