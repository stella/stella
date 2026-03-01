export const EOC_CLASS_NAME = "end-of-content";
export const TEXT_LAYER_ATTRIBUTE = "data-text-layer";
export const PAGE_NUMBER_ATTRIBUTE = "data-page-number";

/**
 * Maximum number of pages that keep their canvas and text layer
 * alive simultaneously. Pages outside this buffer are cleaned up
 * to free memory. Matches Mozilla PDF.js DEFAULT_CACHE_SIZE.
 */
export const DEFAULT_PAGE_BUFFER_SIZE = 10;
