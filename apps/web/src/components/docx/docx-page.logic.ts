import type {
  FIT_TO_WIDTH_MAX_ZOOM,
  FIT_TO_WIDTH_PADDING_PX,
} from "@stll/folio-core/paged-layout/fitWidthZoom";

// The full Letter page at 96 DPI (8.5 × 11 inches). Callers fitting the whole page
// — margins included — divide their available width by DOCX_PAGE_WIDTH instead of
// the text area, so the page sits centred rather than overflowing its side margins;
// the loading sheet sizes its placeholder page from both dimensions.
export const DOCX_PAGE_WIDTH = 816;
export const DOCX_PAGE_HEIGHT = 1056;

// Folio's fit-width constants, held here by value so a loading view drawn
// before any editor code loads can use them; `satisfies` against Folio's
// declared literal types fails the build the day Folio changes either.
const EDITOR_FIT_PADDING_PX = 16 satisfies typeof FIT_TO_WIDTH_PADDING_PX;
const EDITOR_FIT_MAX_ZOOM = 1 satisfies typeof FIT_TO_WIDTH_MAX_ZOOM;

/**
 * The page width the editor's fit gives a page, as CSS, for a view that
 * cannot measure before it paints: the measured box's width (`100cqw`, the
 * nearest inline-size query container, which must be as wide as the box the
 * editor fits to) less the editor's fit padding, up to the page at the
 * editor's largest fitted zoom. The editor rounds its zoom to hundredths and
 * reserves a classic scrollbar once one shows, so the two can differ by under
 * one percent of the page.
 */
export const DOCX_EDITOR_FIT_PAGE_WIDTH_CSS = `min(${String(
  EDITOR_FIT_MAX_ZOOM * DOCX_PAGE_WIDTH,
)}px, calc(100cqw - ${String(EDITOR_FIT_PADDING_PX)}px))`;
