/**
 * The viewer's zoom, as a factor of the page fitted to the screen's width:
 * 1 is the fit the viewer opens at, and − and + walk these steps.
 */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export const FIT_ZOOM = 1;

/** The next step up from `zoom`, or `zoom` itself at the top. */
export const zoomedIn = (zoom: number): number =>
  ZOOM_STEPS.find((step) => step > zoom) ?? zoom;

/** The next step down from `zoom`, or `zoom` itself at the bottom. */
export const zoomedOut = (zoom: number): number => {
  let below = zoom;
  for (const step of ZOOM_STEPS) {
    if (step < zoom) {
      below = step;
    }
  }
  return below;
};

/** folio's own zoom bounds (DocxEditor clamps to them as the web does). */
const FOLIO_MIN_ZOOM = 0.25;
const FOLIO_MAX_ZOOM = 2;

/** folio's zoom for `zoom` times the page width folio fitted, `fitted`. */
export const folioZoom = (fitted: number, zoom: number): number =>
  Math.min(FOLIO_MAX_ZOOM, Math.max(FOLIO_MIN_ZOOM, fitted * zoom));

/**
 * The most pixels one canvas holds. WebKit refuses to draw a larger one, and
 * a zoomed page on a 3× screen passes it.
 */
export const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * The scale a PDF page of `pageWidth` × `pageHeight` points renders at to
 * fill `cssWidth` CSS pixels sharply at `pixelRatio`, lowered so its canvas
 * stays within `MAX_CANVAS_PIXELS`.
 */
export const canvasScale = ({
  cssWidth,
  pageWidth,
  pageHeight,
  pixelRatio,
}: {
  cssWidth: number;
  pageWidth: number;
  pageHeight: number;
  pixelRatio: number;
}): number => {
  const sharp = (cssWidth / pageWidth) * pixelRatio;
  const pixels = pageWidth * sharp * pageHeight * sharp;
  return pixels <= MAX_CANVAS_PIXELS
    ? sharp
    : sharp * Math.sqrt(MAX_CANVAS_PIXELS / pixels);
};

/** The look the viewer is asked for: the app's, or always light or dark. */
export type ViewerAppearance = "system" | "light" | "dark";

/** The appearance after `appearance` as its button cycles them. */
export const nextAppearance = (
  appearance: ViewerAppearance,
): ViewerAppearance => {
  switch (appearance) {
    case "system": {
      return "light";
    }
    case "light": {
      return "dark";
    }
    case "dark": {
      return "system";
    }
  }
};

/** Whether the pages draw light or dark: `appearance`, or the app's scheme. */
export const pageAppearance = (
  appearance: ViewerAppearance,
  scheme: "light" | "dark",
): "light" | "dark" => (appearance === "system" ? scheme : appearance);
