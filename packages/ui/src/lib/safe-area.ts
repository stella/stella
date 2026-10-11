// Device safe areas (notch, home indicator, rounded corners) as Tailwind
// classes over the direction-aware `--safe-area-*` properties in theme.css.
// Every edge-attached surface pads through these, so content never lands
// under the notch or the home indicator once `viewport-fit=cover` is on.

/** A centred overlay viewport: the usual 1rem gutter, or the inset when larger. */
export const SAFE_AREA_OVERLAY_GUTTER_CLASS_NAME =
  "pt-[max(--spacing(4),var(--safe-area-top))] pb-[max(--spacing(4),var(--safe-area-bottom))] ps-[max(--spacing(4),var(--safe-area-inline-start))] pe-[max(--spacing(4),var(--safe-area-inline-end))]";

/** A surface pinned to the bottom edge keeps its last row above the home indicator. */
export const SAFE_AREA_BOTTOM_EDGE_CLASS_NAME = "pb-(--safe-area-bottom)";

/** A surface pinned to the top edge keeps its first row below the status bar. */
export const SAFE_AREA_TOP_EDGE_CLASS_NAME = "pt-(--safe-area-top)";

/** A surface spanning the full width keeps both sides clear of a landscape notch. */
export const SAFE_AREA_INLINE_CLASS_NAME =
  "ps-(--safe-area-inline-start) pe-(--safe-area-inline-end)";
