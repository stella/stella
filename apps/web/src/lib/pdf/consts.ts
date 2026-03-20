export const EOC_CLASS_NAME = "end-of-content";
export const TEXT_LAYER_ATTRIBUTE = "data-text-layer";
export const PAGE_ID_ATTRIBUTE = "data-page-id";

/** Selector for the scroll-area viewport (Radix ScrollArea). */
export const SCROLL_AREA_VIEWPORT_SELECTOR =
  '[data-slot="scroll-area-viewport"]';

/**
 * Maximum number of pages that keep their canvas and text layer
 * alive simultaneously. Pages outside this buffer are cleaned up
 * to free memory. Matches Mozilla PDF.js DEFAULT_CACHE_SIZE.
 */
export const DEFAULT_PAGE_BUFFER_SIZE = 10;

export const DEFAULT_PDF_WIDTH = 768;
