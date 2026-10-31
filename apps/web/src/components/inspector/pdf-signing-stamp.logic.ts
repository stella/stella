import { PDF_SIGNING_STAMP_SIZE_LIMITS_PT } from "@stll/api-contract/limits";

/** A page as displayed (rotation and crop applied), in PDF points. */
export type StampPageSize = {
  height: number;
  width: number;
};

/** Fractions (0..1) of the displayed page, measured from its top-left corner. */
export type StampBox = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type PdfSigningStamp = {
  box: StampBox;
  direction: "ltr" | "rtl";
  labels: {
    date: string;
    location: string;
    reason: string;
    signedBy: string;
  };
  pageIndex: number;
  timeZone: string;
};

export type StampAdjustMode = "move" | "resize";

/** A point in fractions (0..1) of the displayed page, from its top-left corner. */
export type PagePoint = { x: number; y: number };

type Vector = { x: number; y: number };

/** The bounds the API enforces on a visible stamp. */
export const STAMP_LIMITS_PT = PDF_SIGNING_STAMP_SIZE_LIMITS_PT;

const DEFAULT_SIZE_PT = { height: 60, width: 200 } as const;
const DEFAULT_MARGIN_PT = 36;
const KEY_STEP_PT = 4;
/** A drag shorter than this on both axes is a click: it places a default stamp. */
const CLICK_SLOP_PT = 6;
/** Fractions come back a hair off a limit after the page-size round trip. */
const SIZE_TOLERANCE_PT = 1e-6;

// The upper bound wins when the range is empty, so a box never outgrows the
// page it sits on.
const clamp = (value: number, lower: number, upper: number) =>
  Math.min(Math.max(value, lower), upper);

const toPoints = (box: StampBox, page: StampPageSize): StampBox => ({
  height: box.height * page.height,
  width: box.width * page.width,
  x: box.x * page.width,
  y: box.y * page.height,
});

const toFractions = (box: StampBox, page: StampPageSize): StampBox => ({
  height: box.height / page.height,
  width: box.width / page.width,
  x: box.x / page.width,
  y: box.y / page.height,
});

const clampPoints = (box: StampBox, page: StampPageSize): StampBox => {
  const width = clamp(
    box.width,
    STAMP_LIMITS_PT.minWidth,
    Math.min(STAMP_LIMITS_PT.maxWidth, page.width),
  );
  const height = clamp(
    box.height,
    STAMP_LIMITS_PT.minHeight,
    Math.min(STAMP_LIMITS_PT.maxHeight, page.height),
  );
  return {
    height,
    width,
    x: clamp(box.x, 0, page.width - width),
    y: clamp(box.y, 0, page.height - height),
  };
};

/** Whether the page is large enough to hold the smallest allowed stamp. */
export const canPlaceStamp = (page: StampPageSize) =>
  page.width >= STAMP_LIMITS_PT.minWidth &&
  page.height >= STAMP_LIMITS_PT.minHeight;

/** Bottom-right corner of the displayed page, inset by a margin. */
export const defaultStampBox = (page: StampPageSize): StampBox =>
  toFractions(
    clampPoints(
      {
        height: DEFAULT_SIZE_PT.height,
        width: DEFAULT_SIZE_PT.width,
        x: page.width - DEFAULT_SIZE_PT.width - DEFAULT_MARGIN_PT,
        y: page.height - DEFAULT_SIZE_PT.height - DEFAULT_MARGIN_PT,
      },
      page,
    ),
    page,
  );

/** Convert a pointer delta over the rendered preview into page points. */
export const previewDeltaToPoints = ({
  delta,
  page,
  preview,
}: {
  delta: Vector;
  page: StampPageSize;
  preview: StampPageSize;
}): Vector => ({
  x: preview.width > 0 ? (delta.x / preview.width) * page.width : 0,
  y: preview.height > 0 ? (delta.y / preview.height) * page.height : 0,
});

/**
 * Move the whole box, or resize it from its bottom-right corner while its
 * top-left corner stays put. Either way the result stays on the page and
 * within the size limits.
 */
export const adjustStampBox = ({
  box,
  deltaPt,
  mode,
  page,
}: {
  box: StampBox;
  deltaPt: Vector;
  mode: StampAdjustMode;
  page: StampPageSize;
}): StampBox => {
  const points = clampPoints(toPoints(box, page), page);
  if (mode === "move") {
    return toFractions(
      clampPoints(
        { ...points, x: points.x + deltaPt.x, y: points.y + deltaPt.y },
        page,
      ),
      page,
    );
  }
  return toFractions(
    {
      height: clamp(
        points.height + deltaPt.y,
        STAMP_LIMITS_PT.minHeight,
        Math.min(STAMP_LIMITS_PT.maxHeight, page.height - points.y),
      ),
      width: clamp(
        points.width + deltaPt.x,
        STAMP_LIMITS_PT.minWidth,
        Math.min(STAMP_LIMITS_PT.maxWidth, page.width - points.x),
      ),
      x: points.x,
      y: points.y,
    },
    page,
  );
};

const KEY_DIRECTIONS = {
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
} as const satisfies Record<string, Vector>;

const isArrowKey = (key: string): key is keyof typeof KEY_DIRECTIONS =>
  Object.hasOwn(KEY_DIRECTIONS, key);

/** Arrow keys move the box; with Shift they resize it. */
export const stampKeyAdjustment = ({
  key,
  shiftKey,
}: {
  key: string;
  shiftKey: boolean;
}): { deltaPt: Vector; mode: StampAdjustMode } | null => {
  if (!isArrowKey(key)) {
    return null;
  }
  const direction = KEY_DIRECTIONS[key];
  return {
    deltaPt: { x: direction.x * KEY_STEP_PT, y: direction.y * KEY_STEP_PT },
    mode: shiftKey ? "resize" : "move",
  };
};

const clampFraction = (value: number) => clamp(value, 0, 1);

/** Clamp a pointer position to the page it is drawn on. */
export const clampPagePoint = (point: PagePoint): PagePoint => ({
  x: clampFraction(point.x),
  y: clampFraction(point.y),
});

/**
 * The box spanned by a drag from `anchor` to `current`, in whichever
 * direction it went, cut to the page but not yet to the stamp size limits:
 * the preview shows what the pointer drew.
 */
export const drawnStampBox = ({
  anchor,
  current,
}: {
  anchor: PagePoint;
  current: PagePoint;
}): StampBox => {
  const start = clampPagePoint(anchor);
  const end = clampPagePoint(current);
  return {
    height: Math.abs(end.y - start.y),
    width: Math.abs(end.x - start.x),
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
  };
};

export type StampSizeCheck = "fits" | "too_large" | "too_small";

/** Whether a box is inside the size limits the API places a stamp within. */
export const stampSizeCheck = (
  box: StampBox,
  page: StampPageSize,
): StampSizeCheck => {
  const { height, width } = toPoints(box, page);
  if (
    width < STAMP_LIMITS_PT.minWidth - SIZE_TOLERANCE_PT ||
    height < STAMP_LIMITS_PT.minHeight - SIZE_TOLERANCE_PT
  ) {
    return "too_small";
  }
  if (
    width > STAMP_LIMITS_PT.maxWidth + SIZE_TOLERANCE_PT ||
    height > STAMP_LIMITS_PT.maxHeight + SIZE_TOLERANCE_PT
  ) {
    return "too_large";
  }
  return "fits";
};

/** One axis of a released drag: the anchor edge stays, the size is limited. */
const settleSpan = ({
  anchor,
  current,
  max,
  min,
  pageSize,
}: {
  anchor: number;
  current: number;
  max: number;
  min: number;
  pageSize: number;
}) => {
  const size = clamp(Math.abs(current - anchor), min, Math.min(max, pageSize));
  const start = current >= anchor ? anchor : anchor - size;
  return { size, start: clamp(start, 0, pageSize - size) };
};

/**
 * The stamp a released drag leaves on the page. A click places a stamp of
 * the default size with its top-left corner there; a drag keeps the corner
 * it started from and is brought within the size limits; either way the
 * stamp ends up whole on the page. `null` when the page is too small for any
 * stamp.
 */
export const settleDrawnStampBox = ({
  anchor,
  current,
  page,
}: {
  anchor: PagePoint;
  current: PagePoint;
  page: StampPageSize;
}): StampBox | null => {
  if (!canPlaceStamp(page)) {
    return null;
  }
  const start = clampPagePoint(anchor);
  const end = clampPagePoint(current);
  const anchorPt = { x: start.x * page.width, y: start.y * page.height };
  const currentPt = { x: end.x * page.width, y: end.y * page.height };
  const isClick =
    Math.abs(currentPt.x - anchorPt.x) < CLICK_SLOP_PT &&
    Math.abs(currentPt.y - anchorPt.y) < CLICK_SLOP_PT;
  if (isClick) {
    return toFractions(
      clampPoints({ ...DEFAULT_SIZE_PT, ...anchorPt }, page),
      page,
    );
  }
  const horizontal = settleSpan({
    anchor: anchorPt.x,
    current: currentPt.x,
    max: STAMP_LIMITS_PT.maxWidth,
    min: STAMP_LIMITS_PT.minWidth,
    pageSize: page.width,
  });
  const vertical = settleSpan({
    anchor: anchorPt.y,
    current: currentPt.y,
    max: STAMP_LIMITS_PT.maxHeight,
    min: STAMP_LIMITS_PT.minHeight,
    pageSize: page.height,
  });
  return toFractions(
    {
      height: vertical.size,
      width: horizontal.size,
      x: horizontal.start,
      y: vertical.start,
    },
    page,
  );
};
