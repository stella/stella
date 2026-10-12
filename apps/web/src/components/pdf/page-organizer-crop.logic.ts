import type { NormalizedCrop, PageRotation } from "./page-organizer.logic";

export type CropMarginsMm = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type CropPageGeometry = {
  width: number;
  height: number;
  rotation: PageRotation;
};

export type DisplayedCropBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const CROP_ADJUST_MODE = {
  move: "move",
  n: "n",
  ne: "ne",
  e: "e",
  se: "se",
  s: "s",
  sw: "sw",
  w: "w",
  nw: "nw",
} as const;

export const CROP_ADJUST_MODES = Object.values(CROP_ADJUST_MODE);
export type CropAdjustMode = (typeof CROP_ADJUST_MODES)[number];

const MM_PER_POINT = 25.4 / 72;
export const MIN_CROP_SIZE_MM = 10;

export const displayedPageSizeMm = (page: CropPageGeometry) => {
  const swap = page.rotation === 90 || page.rotation === 270;
  return {
    width: (swap ? page.height : page.width) * MM_PER_POINT,
    height: (swap ? page.width : page.height) * MM_PER_POINT,
  };
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const clampMarginPair = (start: number, end: number, size: number) => {
  const first = Math.max(0, start);
  const second = Math.max(0, end);
  const maximum = Math.max(0, size - MIN_CROP_SIZE_MM);
  const sum = first + second;
  const factor = sum > maximum ? maximum / sum : 1;
  return { start: first * factor, end: second * factor };
};

export const clampCropMarginsMm = (
  margins: CropMarginsMm,
  page: CropPageGeometry,
): CropMarginsMm => {
  const size = displayedPageSizeMm(page);
  const horizontal = clampMarginPair(margins.left, margins.right, size.width);
  const vertical = clampMarginPair(margins.top, margins.bottom, size.height);
  return {
    top: vertical.start,
    right: horizontal.end,
    bottom: vertical.end,
    left: horizontal.start,
  };
};

export const displayedCropBox = (
  margins: CropMarginsMm,
  page: CropPageGeometry,
): DisplayedCropBox => {
  const size = displayedPageSizeMm(page);
  const safe = clampCropMarginsMm(margins, page);
  return {
    x: safe.left / size.width,
    y: safe.top / size.height,
    width: 1 - (safe.left + safe.right) / size.width,
    height: 1 - (safe.top + safe.bottom) / size.height,
  };
};

export const marginsFromDisplayedBox = (
  box: DisplayedCropBox,
  page: CropPageGeometry,
): CropMarginsMm => {
  const size = displayedPageSizeMm(page);
  return clampCropMarginsMm(
    {
      top: box.y * size.height,
      right: (1 - box.x - box.width) * size.width,
      bottom: (1 - box.y - box.height) * size.height,
      left: box.x * size.width,
    },
    page,
  );
};

// The worker protocol uses displayed bottom-left coordinates; the PDF transform
// owns rotation back to the original CropBox axes.
export const cropToMarginsMm = (
  crop: NormalizedCrop | undefined,
  page: CropPageGeometry,
): CropMarginsMm =>
  marginsFromDisplayedBox(
    crop
      ? {
          x: crop.x,
          y: 1 - crop.y - crop.height,
          width: crop.width,
          height: crop.height,
        }
      : { x: 0, y: 0, width: 1, height: 1 },
    page,
  );

export const marginsMmToCrop = (
  margins: CropMarginsMm,
  page: CropPageGeometry,
): NormalizedCrop => {
  const safe = clampCropMarginsMm(margins, page);
  const size = displayedPageSizeMm(page);
  const box = displayedCropBox(safe, page);
  return {
    x: box.x,
    y: safe.bottom / size.height,
    width: box.width,
    height: box.height,
  };
};

type AdjustCropBoxOptions = {
  box: DisplayedCropBox;
  delta: { x: number; y: number };
  mode: CropAdjustMode;
  page: CropPageGeometry;
};

export const adjustCropBox = ({
  box,
  delta,
  mode,
  page,
}: AdjustCropBoxOptions): DisplayedCropBox => {
  if (mode === "move") {
    return {
      ...box,
      x: clamp(box.x + delta.x, 0, 1 - box.width),
      y: clamp(box.y + delta.y, 0, 1 - box.height),
    };
  }
  const size = displayedPageSizeMm(page);
  const minWidth = Math.min(1, MIN_CROP_SIZE_MM / size.width);
  const minHeight = Math.min(1, MIN_CROP_SIZE_MM / size.height);
  let left = box.x;
  let right = box.x + box.width;
  let top = box.y;
  let bottom = box.y + box.height;
  if (mode.includes("w")) {
    left = clamp(left + delta.x, 0, right - minWidth);
  }
  if (mode.includes("e")) {
    right = clamp(right + delta.x, left + minWidth, 1);
  }
  if (mode.includes("n")) {
    top = clamp(top + delta.y, 0, bottom - minHeight);
  }
  if (mode.includes("s")) {
    bottom = clamp(bottom + delta.y, top + minHeight, 1);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
};

export const cropKeyDelta = (
  key: string,
  shift: boolean,
): { x: number; y: number } | null => {
  const distance = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft":
      return { x: -distance, y: 0 };
    case "ArrowRight":
      return { x: distance, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -distance };
    case "ArrowDown":
      return { x: 0, y: distance };
    default:
      return null;
  }
};
