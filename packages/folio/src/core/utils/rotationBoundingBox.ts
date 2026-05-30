/**
 * Rotation bounding-box math shared by the layout measurer and the layout
 * painter. Lives in `utils/` (not `layout-painter/`) so the measurer can
 * import it without re-introducing the painter→measurer→painter cycle that
 * `renderUtils.ts` was originally split to avoid.
 *
 * eigenpal #424 (rotation bbox gap 8 follow-up).
 */

import type { ImageRun } from "../layout-engine/types";

export type BoundingBox = { width: number; height: number };

// Parse the rotation angle (degrees, normalized to [0, 360)) from a CSS
// `transform` string like `"rotate(90deg) scaleX(-1)"`. Returns 0 when no
// `rotate()` term is present. CSS function/unit names are case-insensitive
// per spec, so accept `ROTATE(...)` / `DEG` too; whitespace inside
// `rotate(...)` is also valid CSS, so accept it defensively.
export function parseRotationDegrees(transform: string | undefined): number {
  if (!transform) {
    return 0;
  }
  const match = /rotate\(\s*([-\d.]+)\s*deg\s*\)/iu.exec(transform);
  if (!match) {
    return 0;
  }
  const raw = Number.parseFloat(match[1]!);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return ((raw % 360) + 360) % 360;
}

// Axis-aligned bounding box of a `w × h` rectangle rotated by `deg` degrees.
// 90°/270° swap the dims exactly (no FP drift); 0°/180° keep them; arbitrary
// angles use the standard |cos θ|·w + |sin θ|·h formula.
export function rotatedBoundingBox(
  w: number,
  h: number,
  deg: number,
): BoundingBox {
  if (deg === 0 || deg === 180) {
    return { width: w, height: h };
  }
  if (deg === 90 || deg === 270) {
    return { width: h, height: w };
  }
  const rad = (deg * Math.PI) / 180;
  const sinA = Math.abs(Math.sin(rad));
  const cosA = Math.abs(Math.cos(rad));
  return { width: w * cosA + h * sinA, height: w * sinA + h * cosA };
}

// Convenience: the axis-aligned bbox of an inline image after applying its
// `transform`. Returns `{ width: run.width, height: run.height }` when no
// rotation is present so the unrotated fast path stays a no-op for callers.
export function inlineImageBoundingBox(run: ImageRun): BoundingBox {
  const rotation = parseRotationDegrees(run.transform);
  if (rotation === 0) {
    return { width: run.width, height: run.height };
  }
  return rotatedBoundingBox(run.width, run.height, rotation);
}
