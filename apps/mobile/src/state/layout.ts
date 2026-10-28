/**
 * Below this window size the app shows one column, as on a phone: an iPad
 * in Slide Over or a narrow split, or a folded phone.
 */
export const SPLIT_LAYOUT_MIN_WIDTH = 720;
export const SPLIT_LAYOUT_MIN_HEIGHT = 600;

/** The list column's bounds beside a selection. */
const LIST_PANE_MIN_WIDTH = 300;
const LIST_PANE_MAX_WIDTH = 400;
/** The list column's share of the window between those bounds. */
const LIST_PANE_SHARE = 0.36;
/** The least a selection's column takes, beside a list split at a fold. */
const DETAIL_PANE_MIN_WIDTH = 320;
/** The least a list's column takes, beside a selection split at a fold. */
const FOLD_LIST_PANE_MIN_WIDTH = 280;

/** What the platform reports about the window beyond its size. */
export type LayoutMetrics = {
  readonly hasHinge: boolean;
  readonly horizontalSizeClass: "compact" | "regular";
  readonly safeAreaLeft: number;
  readonly safeAreaRight: number;
  /** The region UIKit reserves for a fold, in window points. */
  readonly division?:
    | {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      }
    | undefined;
};

export type Layout =
  | { readonly usesSplitView: false }
  | {
      readonly usesSplitView: true;
      /** The list's column; the selection fills the rest. */
      readonly listPaneWidth: number;
      /** The fold between the columns, which holds nothing. */
      readonly divisionWidth: number;
    };

/**
 * One column on a phone; on an iPad or an unfolded foldable iPhone wide and
 * tall enough, t3code's two: a tab's list beside what is selected in it.
 * The window, not the device, decides, so Slide Over and a narrow Split
 * View on an iPad keep one column. Where a fold divides the window, the
 * columns meet at the fold so nothing is drawn across it; a folded phone,
 * compact however it is turned, keeps one column.
 */
export const deriveLayout = ({
  height,
  metrics,
  width,
}: {
  readonly height: number;
  readonly metrics?: LayoutMetrics | null | undefined;
  readonly width: number;
}): Layout => {
  const division = metrics?.division;
  if (
    division !== undefined &&
    division.height >= height / 2 &&
    division.x - (metrics?.safeAreaLeft ?? 0) >= FOLD_LIST_PANE_MIN_WIDTH &&
    width - division.x - division.width - (metrics?.safeAreaRight ?? 0) >=
      DETAIL_PANE_MIN_WIDTH
  ) {
    return {
      usesSplitView: true,
      listPaneWidth: Math.round(division.x),
      divisionWidth: Math.round(division.width),
    };
  }
  if (metrics?.hasHinge === true && metrics.horizontalSizeClass === "compact") {
    return { usesSplitView: false };
  }
  if (width < SPLIT_LAYOUT_MIN_WIDTH || height < SPLIT_LAYOUT_MIN_HEIGHT) {
    return { usesSplitView: false };
  }
  return {
    usesSplitView: true,
    listPaneWidth: Math.round(
      Math.min(
        LIST_PANE_MAX_WIDTH,
        Math.max(LIST_PANE_MIN_WIDTH, width * LIST_PANE_SHARE),
      ),
    ),
    divisionWidth: 0,
  };
};
