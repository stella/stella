import { panic } from "better-result";

export type ManualRedactionRegion = {
  readonly pageIndex: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

export type ManualRedactionSelection = ManualRedactionRegion & {
  readonly id: string;
};

export type DisplayedPdfPageDimensions = {
  readonly widthPoints: number;
  readonly heightPoints: number;
};

// A page-relative threshold remains stable when the reader zoom changes.
const MIN_NORMALIZED_EDGE = 0.002;
const MAX_HISTORY_ENTRIES = 100;

export type ManualRedactionPageRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export const isManualRedactionPageRectUnchanged = (
  initial: ManualRedactionPageRect,
  current: ManualRedactionPageRect,
): boolean =>
  initial.left === current.left &&
  initial.top === current.top &&
  initial.width === current.width &&
  initial.height === current.height;

type ManualRedactionDrag = {
  pageIndex: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
  pageRect: ManualRedactionPageRect;
};

export const manualRedactionFromDrag = ({
  pageIndex,
  start,
  end,
  pageRect,
}: ManualRedactionDrag): ManualRedactionRegion | null => {
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 0 ||
    ![
      start.x,
      start.y,
      end.x,
      end.y,
      pageRect.left,
      pageRect.top,
      pageRect.width,
      pageRect.height,
    ].every(Number.isFinite) ||
    pageRect.width <= 0 ||
    pageRect.height <= 0
  ) {
    return null;
  }
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const left = clamp(
    (Math.min(start.x, end.x) - pageRect.left) / pageRect.width,
  );
  const right = clamp(
    (Math.max(start.x, end.x) - pageRect.left) / pageRect.width,
  );
  const top = clamp(
    (Math.min(start.y, end.y) - pageRect.top) / pageRect.height,
  );
  const bottom = clamp(
    (Math.max(start.y, end.y) - pageRect.top) / pageRect.height,
  );
  if (
    right - left < MIN_NORMALIZED_EDGE ||
    bottom - top < MIN_NORMALIZED_EDGE
  ) {
    return null;
  }
  return { pageIndex, left, top, right, bottom };
};

const isValidRegion = (region: ManualRedactionRegion) =>
  Number.isSafeInteger(region.pageIndex) &&
  region.pageIndex >= 0 &&
  [region.left, region.top, region.right, region.bottom].every(
    Number.isFinite,
  ) &&
  region.left >= 0 &&
  region.top >= 0 &&
  region.right <= 1 &&
  region.bottom <= 1 &&
  region.right > region.left &&
  region.bottom > region.top;

// Dimensions belong to the displayed orientation. Rotated pages have already
// exchanged their axes; mapping back to the raw PDF box would redact elsewhere.
export const manualRedactionToPdfPoints = (
  region: ManualRedactionRegion,
  { widthPoints, heightPoints }: DisplayedPdfPageDimensions,
) => {
  if (
    !isValidRegion(region) ||
    !Number.isFinite(widthPoints) ||
    !Number.isFinite(heightPoints) ||
    widthPoints <= 0 ||
    heightPoints <= 0
  ) {
    panic(
      "Manual redaction requires a valid region and displayed page dimensions",
    );
  }
  return {
    pageIndex: region.pageIndex,
    left: region.left * widthPoints,
    bottom: (1 - region.bottom) * heightPoints,
    right: region.right * widthPoints,
    top: (1 - region.top) * heightPoints,
  };
};

export type ManualRedactionHistory = {
  readonly past: readonly (readonly ManualRedactionSelection[])[];
  readonly present: readonly ManualRedactionSelection[];
  readonly future: readonly (readonly ManualRedactionSelection[])[];
};

export type ManualRedactionAction =
  | { type: "add"; selection: ManualRedactionSelection }
  | { type: "remove"; id: string }
  | { type: "reset" }
  | { type: "undo" }
  | { type: "redo" };

export const createManualRedactionHistory = (): ManualRedactionHistory => ({
  past: [],
  present: [],
  future: [],
});

const commit = (
  history: ManualRedactionHistory,
  present: readonly ManualRedactionSelection[],
): ManualRedactionHistory => ({
  past: [...history.past, history.present].slice(-MAX_HISTORY_ENTRIES),
  present,
  future: [],
});

export const reduceManualRedactionHistory = (
  history: ManualRedactionHistory,
  action: ManualRedactionAction,
): ManualRedactionHistory => {
  switch (action.type) {
    case "add": {
      if (
        !action.selection.id ||
        !isValidRegion(action.selection) ||
        history.present.some(({ id }) => id === action.selection.id)
      ) {
        panic("Manual redaction selection must be valid and have a unique id");
      }
      return commit(history, [...history.present, { ...action.selection }]);
    }
    case "remove": {
      const present = history.present.filter(({ id }) => id !== action.id);
      return present.length === history.present.length
        ? history
        : commit(history, present);
    }
    case "reset":
      return history.present.length === 0 ? history : commit(history, []);
    case "undo": {
      const present = history.past.at(-1);
      if (present === undefined) {
        return history;
      }
      return {
        past: history.past.slice(0, -1),
        present,
        future: [history.present, ...history.future],
      };
    }
    case "redo": {
      const present = history.future.at(0);
      if (present === undefined) {
        return history;
      }
      return {
        past: [...history.past, history.present].slice(-MAX_HISTORY_ENTRIES),
        present,
        future: history.future.slice(1),
      };
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
};
