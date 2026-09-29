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

type Vector = { x: number; y: number };

export const STAMP_LIMITS_PT = {
  maxHeight: 200,
  maxWidth: 400,
  minHeight: 24,
  minWidth: 72,
} as const;

const DEFAULT_SIZE_PT = { height: 60, width: 200 } as const;
const DEFAULT_MARGIN_PT = 36;
const KEY_STEP_PT = 4;

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
