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

// Width, inspector clamping and placement share the same safe rectangle. In
// particular, an inline-end inspector must leave room for the opposite notch.
export const SAFE_AREA_TOAST_GEOMETRY_CLASS_NAME =
  "[--toast-safe-width:max(0px,calc(100vw-var(--toast-inset)*2-var(--safe-area-inline-start)-var(--safe-area-inline-end)))] [--toast-offset:0px] md:data-[position*=right]:[--toast-offset:clamp(0px,var(--stella-toast-right-offset,0px),max(0px,calc(var(--toast-safe-width)-10rem)))] w-[max(0px,calc(var(--toast-safe-width)-var(--toast-offset)))] data-[position*=left]:start-[calc(var(--toast-inset)+var(--safe-area-inline-start))] data-[position*=right]:end-[calc(var(--toast-inset)+var(--safe-area-inline-end)+var(--toast-offset))] data-[position*=center]:start-[calc(var(--toast-inset)+var(--safe-area-inline-start)+var(--toast-safe-width)/2)] data-[position*=center]:-translate-x-1/2 rtl:data-[position*=center]:translate-x-1/2";
