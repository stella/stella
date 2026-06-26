import type { PageMargins } from "../layout-engine/types";
import type { SectionProperties } from "../types/document";

export const DEFAULT_PAGE_WIDTH_PX = 816;
export const DEFAULT_PAGE_HEIGHT_PX = 1056;
export const DEFAULT_BODY_MARGIN_PX = 96;
export const DEFAULT_HEADER_FOOTER_DISTANCE_PX = 48;

const DEFAULT_MARGINS: PageMargins = {
  top: DEFAULT_BODY_MARGIN_PX,
  right: DEFAULT_BODY_MARGIN_PX,
  bottom: DEFAULT_BODY_MARGIN_PX,
  left: DEFAULT_BODY_MARGIN_PX,
};

export const twipsToPixels = (twips: number): number =>
  Math.round((twips / 1440) * 96);

/**
 * Convert an offset-like twip dimension to px. Explicit 0 is meaningful for
 * page margins and header/footer distances; only absence should use fallback.
 */
export const twipsToPxOr = (
  twips: number | null | undefined,
  fallbackPx: number,
): number =>
  twips !== null && twips !== undefined ? twipsToPixels(twips) : fallbackPx;

/**
 * Convert a page-dimension twip value to px. Page dimensions must be positive:
 * a literal 0 is malformed and, like an absent value, uses the fallback.
 */
const pageDimToPx = (
  twips: number | null | undefined,
  fallbackPx: number,
): number =>
  twips !== null && twips !== undefined && twips > 0
    ? twipsToPixels(twips)
    : fallbackPx;

export const getPageSize = (
  sectionProps: SectionProperties | null | undefined,
): { w: number; h: number } => ({
  w: pageDimToPx(sectionProps?.pageWidth, DEFAULT_PAGE_WIDTH_PX),
  h: pageDimToPx(sectionProps?.pageHeight, DEFAULT_PAGE_HEIGHT_PX),
});

export const getMargins = (
  sectionProps: SectionProperties | null | undefined,
): PageMargins => ({
  top: twipsToPxOr(sectionProps?.marginTop, DEFAULT_MARGINS.top),
  right: twipsToPxOr(sectionProps?.marginRight, DEFAULT_MARGINS.right),
  bottom: twipsToPxOr(sectionProps?.marginBottom, DEFAULT_MARGINS.bottom),
  left: twipsToPxOr(sectionProps?.marginLeft, DEFAULT_MARGINS.left),
  header: twipsToPxOr(
    sectionProps?.headerDistance,
    DEFAULT_HEADER_FOOTER_DISTANCE_PX,
  ),
  footer: twipsToPxOr(
    sectionProps?.footerDistance,
    DEFAULT_HEADER_FOOTER_DISTANCE_PX,
  ),
});
