/**
 * The viewer's zoom, as a factor of the page fitted to the screen's width:
 * 1 is the fit the viewer opens at, and − and + walk these steps. They stay
 * within folio's bounds for a phone's fit, so each step shows as labelled.
 */
export const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2] as const;

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
 * The zoom to set folio to, or null to leave it fitting the page itself.
 * folio's fit grows with the screen's width, so `fitPerPixel` (its fit over
 * the width it fitted) gives the fit at any `width`, as the screen turns.
 * Until the person first zooms (`zoomed`), folio keeps its own fit.
 */
export const docxZoomTarget = ({
  fitPerPixel,
  width,
  zoom,
  zoomed,
}: {
  fitPerPixel: number | null;
  width: number;
  zoom: number;
  zoomed: boolean;
}): number | null =>
  fitPerPixel === null || (zoom === FIT_ZOOM && !zoomed)
    ? null
    : folioZoom(fitPerPixel * width, zoom);

/**
 * Where a scroller's offset along one axis moves when its content, after
 * `lead` pixels of padding that do not scale, scales by `ratio`, so the
 * point at the middle of its `viewport` stays there.
 */
export const scaledScroll = ({
  offset,
  viewport,
  ratio,
  lead,
}: {
  offset: number;
  viewport: number;
  ratio: number;
  lead: number;
}): number =>
  Math.max(0, (offset + viewport / 2 - lead) * ratio + lead - viewport / 2);

/**
 * The most pixels one canvas holds. WebKit refuses to draw a larger one,
 * which a page zoomed in on a wide 3× screen passes. Pages far from the
 * screen give their canvases back (./pdf-pages.tsx), which keeps the total
 * across canvases down as well.
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

/** The appearance after each, as its button cycles them. */
const NEXT_APPEARANCE = {
  system: "light",
  light: "dark",
  dark: "system",
} as const satisfies Record<ViewerAppearance, ViewerAppearance>;

/** The appearance after `appearance` as its button cycles them. */
export const nextAppearance = (
  appearance: ViewerAppearance,
): ViewerAppearance => NEXT_APPEARANCE[appearance];

/** Whether the pages draw light or dark: `appearance`, or the app's scheme. */
export const pageAppearance = (
  appearance: ViewerAppearance,
  scheme: "light" | "dark",
): "light" | "dark" => (appearance === "system" ? scheme : appearance);
