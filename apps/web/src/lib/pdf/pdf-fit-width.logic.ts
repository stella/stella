/**
 * Space a PDF viewer keeps clear on each inline side of its pages, in CSS
 * pixels. The viewport pads its column of pages by this much, and a page
 * fitted to the viewer's width is narrower by twice this, so it never runs
 * under the edge. It also holds the overlay scrollbar, which takes 14px at the
 * inline end (`ScrollBar` in `@stll/ui/scroll-area`: a 6px track with a 4px
 * margin on each side) and paints over the content instead of taking space
 * from it; being the same on both sides, the page stays centred in either
 * writing direction.
 */
export const PDF_PAGE_INLINE_INSET_PX = 16;

/** The width a page fitted to a viewer whose viewport is `viewportWidth` wide gets. */
export const fittedPageWidth = (viewportWidth: number): number =>
  Math.max(viewportWidth - 2 * PDF_PAGE_INLINE_INSET_PX, 1);
