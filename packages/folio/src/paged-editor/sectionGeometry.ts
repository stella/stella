import type { PageMargins } from "../core/layout-engine/types";
import type { SectionProperties } from "../core/types/document";

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
): number => (twips != null ? twipsToPixels(twips) : fallbackPx);

export const getPageSize = (
  sectionProps: SectionProperties | null | undefined,
): { w: number; h: number } => ({
  // Page size is defensive: a literal 0 is malformed and falls back to Letter.
  w: sectionProps?.pageWidth
    ? twipsToPixels(sectionProps.pageWidth)
    : DEFAULT_PAGE_WIDTH_PX,
  h: sectionProps?.pageHeight
    ? twipsToPixels(sectionProps.pageHeight)
    : DEFAULT_PAGE_HEIGHT_PX,
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
