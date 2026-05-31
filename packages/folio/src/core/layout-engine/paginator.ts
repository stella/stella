/**
 * Paginator - manages page state during layout
 *
 * Tracks the current page, cursor position, and available space.
 * Creates new pages when content doesn't fit.
 */

import { panic } from "better-result";

import type {
  Page,
  PageMargins,
  Fragment,
  ColumnLayout,
  PageHeaderFooterRefs,
} from "./types";
import { FOOTNOTE_SEPARATOR_HEIGHT } from "./types";

/**
 * Re-export the canonical footnote separator height so engine call sites can
 * continue importing it from the paginator. The single source of truth lives
 * in `layout-engine/types.ts` and is shared with the bridge (footnote stack
 * height calc) and the painter (separator margins). Mirrors
 * eigenpal/docx-editor#485.
 */
export { FOOTNOTE_SEPARATOR_HEIGHT };

/**
 * Current state of a page being laid out.
 */
export type PageState = {
  /** The page being built. */
  page: Page;
  /** Current Y position (cursor) from page top. */
  cursorY: number;
  /** Current column index (0-based). */
  columnIndex: number;
  /** Top margin of content area. */
  topMargin: number;
  /**
   * Bottom boundary of usable body content area.
   * Equals `pageBottom - footnoteHeight`. Recomputed when footnote
   * demand grows (a line carrying a fn ref is placed on this page).
   */
  contentBottom: number;
  /** Raw bottom of content area (page height - bottom margin); excludes fn area. */
  rawContentBottom: number;
  /** Total height reserved for footnotes on this page (grows as refs are placed). */
  footnoteHeight: number;
  /** Accumulated trailing spacing (space after previous block). */
  trailingSpacing: number;
};

/**
 * Options for creating a paginator.
 */
export type PaginatorOptions = {
  /** Page size (width, height). */
  pageSize: { w: number; h: number };
  /** Page margins. */
  margins: PageMargins;
  /**
   * Margins applied only to the very first page (page 1) of the paginator.
   * Used when a `<w:titlePg/>`-enabled section needs different margins for
   * its title page (typically extended top margin to clear an overflowing
   * first-page header) vs. its body pages. Pages 2+ use `margins`.
   */
  firstPageMargins?: PageMargins;
  /** Column configuration (optional). */
  columns?: ColumnLayout;
  /** Per-page footnote reserved heights (pageNumber → height in pixels). */
  footnoteReservedHeights?: Map<number, number>;
  /** Header/footer refs by section index. */
  sectionHeaderFooterRefs?: PageHeaderFooterRefs[];
  /** Callback when a new page is created. */
  onNewPage?: (state: PageState) => void;
};

type ForcePageBreakOptions = {
  coalesceBlankPage?: boolean;
};

/**
 * Calculate the width of a single column.
 */
function calculateColumnWidth(
  pageWidth: number,
  leftMargin: number,
  rightMargin: number,
  columns: ColumnLayout,
): number {
  const contentWidth = pageWidth - leftMargin - rightMargin;
  const totalGaps = (columns.count - 1) * columns.gap;
  return (contentWidth - totalGaps) / columns.count;
}

function arePageSizesEqual(
  left: { w: number; h: number },
  right: { w: number; h: number },
): boolean {
  return left.w === right.w && left.h === right.h;
}

function areMarginsEqual(left: PageMargins, right: PageMargins): boolean {
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left &&
    left.header === right.header &&
    left.footer === right.footer
  );
}

/**
 * Creates a paginator for managing page layout state.
 */
export function createPaginator(options: PaginatorOptions) {
  let pageSize = { ...options.pageSize };
  let margins = { ...options.margins };
  let columns: ColumnLayout = options.columns ?? { count: 1, gap: 0 };
  let pendingPageSize: { w: number; h: number } | undefined;
  let pendingMargins: PageMargins | undefined;
  let currentSectionIndex = 0;
  let currentSectionPageNumber = 0;

  const pages: Page[] = [];
  const states: PageState[] = [];

  function getContentBottom(): number {
    return pageSize.h - margins.bottom;
  }

  function getContentHeight(): number {
    return getContentBottom() - margins.top;
  }

  function getContentWidth(): number {
    return pageSize.w - margins.left - margins.right;
  }

  function currentPageUsesActiveLayout(state: PageState): boolean {
    if (pendingPageSize || pendingMargins) {
      return false;
    }
    return (
      arePageSizesEqual(state.page.size, pageSize) &&
      areMarginsEqual(state.page.margins, margins)
    );
  }

  if (getContentHeight() <= 0) {
    panic("Paginator: page size and margins yield no content area");
  }

  // Calculate column width
  let columnWidth = calculateColumnWidth(
    pageSize.w,
    margins.left,
    margins.right,
    columns,
  );

  // Track where column content starts on the current page.
  // Defaults to topMargin but gets updated when columns change mid-page
  // (continuous section break). When advanceColumn moves to the next column,
  // it resets cursorY to this value instead of topMargin.
  let columnRegionTop = margins.top;

  /**
   * Get X position for a given column index.
   */
  function getColumnX(columnIndex: number): number {
    return margins.left + columnIndex * (columnWidth + columns.gap);
  }

  /**
   * Create a new page and add it to the list.
   */
  function createNewPage(): PageState {
    if (pendingPageSize || pendingMargins) {
      if (pendingPageSize) {
        pageSize = pendingPageSize;
      }
      if (pendingMargins) {
        margins = pendingMargins;
      }
      pendingPageSize = undefined;
      pendingMargins = undefined;
      columnWidth = calculateColumnWidth(
        pageSize.w,
        margins.left,
        margins.right,
        columns,
      );
    }

    const pageNumber = pages.length + 1;
    currentSectionPageNumber += 1;
    // Page 1 of the document may use first-page margins (extended top to
    // clear an overflowing first-page header on a titlePg section) while
    // pages 2+ use the regular section margins. Without this distinction
    // every page in the section would inherit page 1's title-page top
    // margin, leaving large empty space at the top of pages 2+ on
    // first-page-header docs (NVCA-style templates).
    const pageMargins =
      pageNumber === 1 && options.firstPageMargins
        ? { ...options.firstPageMargins }
        : { ...margins };
    const topMargin = pageMargins.top;
    const contentBottom = pageSize.h - pageMargins.bottom;

    // Reduce content bottom by footnote reserved height for this page.
    // Used as a static reservation only when the layout engine isn't
    // tracking footnote demand dynamically per line. The dynamic path
    // (see `addFootnoteHeight`) starts at zero and grows as fn-ref-
    // carrying lines are placed.
    const footnoteHeight =
      options.footnoteReservedHeights?.get(pageNumber) ?? 0;
    const pageContentBottom = contentBottom - footnoteHeight;

    const page: Page = {
      number: pageNumber,
      fragments: [],
      margins: pageMargins,
      size: { ...pageSize },
      ...(footnoteHeight > 0 ? { footnoteReservedHeight: footnoteHeight } : {}),
      // Set initial columns; may be overwritten by updateColumns() for continuous section breaks
      ...(columns.count > 1 ? { columns: { ...columns } } : {}),
    };
    applySectionMetadata(page);

    const state: PageState = {
      page,
      cursorY: topMargin,
      columnIndex: 0,
      topMargin,
      contentBottom: pageContentBottom,
      rawContentBottom: contentBottom,
      footnoteHeight,
      trailingSpacing: 0,
    };

    pages.push(page);
    states.push(state);

    // Reset column region to page top on new page
    columnRegionTop = topMargin;

    if (options.onNewPage) {
      options.onNewPage(state);
    }

    return state;
  }

  /**
   * Get the current page state, creating one if none exists.
   */
  function getCurrentState(): PageState {
    if (states.length === 0) {
      return createNewPage();
    }
    // states.length > 0 is guaranteed by the guard above
    const last = states.at(-1);
    if (!last) {
      return createNewPage();
    }
    return last;
  }

  /**
   * Get available height remaining on the current column.
   */
  function getAvailableHeight(state: PageState): number {
    return state.contentBottom - state.cursorY;
  }

  /**
   * Check if the given height fits in the current column.
   */
  function fits(height: number, state?: PageState): boolean {
    const s = state || getCurrentState();
    return getAvailableHeight(s) >= height;
  }

  /**
   * Advance to the next column, or create a new page if no more columns.
   */
  function advanceColumn(state: PageState): PageState {
    // Check if there are more columns on this page
    if (state.columnIndex < columns.count - 1) {
      state.columnIndex += 1;
      state.cursorY = columnRegionTop;
      state.trailingSpacing = 0;
      return state;
    }

    // No more columns, create new page
    return createNewPage();
  }

  /**
   * Ensure content of given height can fit.
   * Advances column or creates new page if needed.
   * Returns the state to use for placement.
   */
  function ensureFits(height: number): PageState {
    let state = getCurrentState();
    const safeHeight = Number.isFinite(height) && height > 0 ? height : 0;

    // Keep advancing until we have space
    while (!fits(safeHeight, state)) {
      const columnCapacity = state.contentBottom - state.topMargin;
      if (safeHeight > columnCapacity) {
        if (state.cursorY !== state.topMargin) {
          state = advanceColumn(state);
        }
        return state;
      }
      state = advanceColumn(state);
    }

    return state;
  }

  /**
   * Add a fragment to the current page at the cursor position.
   * Updates cursor position after placement.
   */
  function addFragment(
    fragment: Fragment,
    height: number,
    spaceBefore: number = 0,
    spaceAfter: number = 0,
  ): { state: PageState; x: number; y: number } {
    const initialState = getCurrentState();
    const initialColumnIndex = initialState.columnIndex;

    // Collapse space before with trailing spacing from previous block
    const effectiveSpaceBefore = Math.max(
      spaceBefore,
      initialState.trailingSpacing,
    );
    const totalHeight = effectiveSpaceBefore + height;

    // Ensure we have space
    const state = ensureFits(totalHeight);

    const isSameFlowRegion =
      state === initialState && state.columnIndex === initialColumnIndex;
    const actualSpaceBefore = isSameFlowRegion
      ? effectiveSpaceBefore
      : spaceBefore;

    // Calculate position
    const x = getColumnX(state.columnIndex);
    const y = state.cursorY + actualSpaceBefore;

    // Position the fragment
    fragment.x = x;
    fragment.y = y;

    // Add to page
    state.page.fragments.push(fragment);

    // Update cursor
    state.cursorY = y + height;
    state.trailingSpacing = spaceAfter;

    return { state, x, y };
  }

  /**
   * Reserve additional footnote area on the current page.
   *
   * Called by the layout engine each time a body line carrying a
   * footnote ref is placed: the page must shrink its body area by
   * the fn content's height so the fn can render below without
   * overflowing into the footer. Updates both `state.contentBottom`
   * (so subsequent line-fitting checks see the reduced space) and
   * `state.page.footnoteReservedHeight` (so the painter draws the fn
   * area at the correct top).
   *
   * On the first fn added to a page, additionally reserves
   * `FOOTNOTE_SEPARATOR_HEIGHT` for the divider line + its margins so
   * the separator stays inside the reserved slot.
   *
   * Caller is responsible for ensuring the line itself fits *with*
   * `additionalHeight` already accounted for; if the line should have
   * advanced to the next page, the engine must check that *before*
   * committing the line + reservation.
   */
  function addFootnoteHeight(
    additionalHeight: number,
    footnoteIds?: number[],
  ): void {
    if (!Number.isFinite(additionalHeight) || additionalHeight <= 0) {
      return;
    }
    const state = getCurrentState();
    const separatorOverhead =
      state.footnoteHeight === 0 ? FOOTNOTE_SEPARATOR_HEIGHT : 0;
    state.footnoteHeight += additionalHeight + separatorOverhead;
    state.contentBottom = state.rawContentBottom - state.footnoteHeight;
    state.page.footnoteReservedHeight = state.footnoteHeight;
    // Record which fn IDs landed on *this* page. Driven by the
    // line-level placement in the engine (not by post-layout
    // pmRange mapping) so a fn ref in a continuation fragment of a
    // split paragraph is correctly attributed to the page where the
    // ref-bearing line actually lives — Codex PR #258 review.
    if (footnoteIds && footnoteIds.length > 0) {
      const existing = state.page.footnoteIds ?? [];
      for (const id of footnoteIds) {
        if (!existing.includes(id)) {
          existing.push(id);
        }
      }
      state.page.footnoteIds = existing;
    }
  }

  /**
   * Force a page break - move to a new page.
   */
  function forcePageBreak(breakOptions: ForcePageBreakOptions = {}): PageState {
    const current = states.at(-1);
    if (
      breakOptions.coalesceBlankPage &&
      current &&
      current.page.fragments.length === 0 &&
      current.cursorY === current.topMargin &&
      currentPageUsesActiveLayout(current)
    ) {
      if (current.page.sectionIndex !== currentSectionIndex) {
        currentSectionPageNumber = 1;
        applySectionMetadata(current.page);
      }
      return current;
    }
    return createNewPage();
  }

  /**
   * Force a column break - move to next column or new page.
   */
  function forceColumnBreak(): PageState {
    const state = getCurrentState();
    return advanceColumn(state);
  }

  /**
   * Update column configuration mid-document (for section breaks).
   * Recalculates column width based on current page/margin dimensions.
   * Sets columnRegionTop to the current cursor position so that
   * column advancement stays below existing content (for continuous breaks).
   */
  function updateColumns(newColumns: ColumnLayout): void {
    columns = newColumns;
    columnWidth = calculateColumnWidth(
      pageSize.w,
      margins.left,
      margins.right,
      columns,
    );

    // Update current page's column info for rendering
    const state = getCurrentState();
    if (columns.count > 1) {
      state.page.columns = { ...columns };
    } else {
      delete state.page.columns;
    }

    // Set column region top to current cursor position.
    // This ensures that when advancing columns, new columns start
    // at the same Y as where the multi-column content began (not page top).
    columnRegionTop = state.cursorY;

    // Reset to column 0 for the new column layout
    state.columnIndex = 0;
  }

  function updatePageLayout(
    newPageSize?: { w: number; h: number },
    newMargins?: PageMargins,
    applyImmediately = true,
  ): void {
    if (!applyImmediately) {
      pendingPageSize = newPageSize ? { ...newPageSize } : pendingPageSize;
      pendingMargins = newMargins ? { ...newMargins } : pendingMargins;
      return;
    }

    if (newPageSize) {
      pageSize = { ...newPageSize };
    }
    if (newMargins) {
      margins = { ...newMargins };
    }
    if (getContentHeight() <= 0) {
      panic("Paginator: section page size and margins yield no content area");
    }
    columnWidth = calculateColumnWidth(
      pageSize.w,
      margins.left,
      margins.right,
      columns,
    );
    pendingPageSize = undefined;
    pendingMargins = undefined;
  }

  function startSection(sectionIndex: number): void {
    currentSectionIndex = sectionIndex;
    currentSectionPageNumber = 0;
  }

  function applySectionMetadata(page: Page): void {
    page.sectionIndex = currentSectionIndex;
    page.sectionPageNumber = currentSectionPageNumber;
    const refs = options.sectionHeaderFooterRefs?.[currentSectionIndex];
    if (refs) {
      page.headerFooterRefs = refs;
    } else {
      delete page.headerFooterRefs;
    }
  }

  return {
    /** All pages created so far. */
    pages,
    /** All page states. */
    states,
    /** Column width in pixels (use getColumnWidth() for current value after updates). */
    get columnWidth() {
      return columnWidth;
    },
    /** Get current column layout (returns copy to prevent external mutation). */
    get columns() {
      return { ...columns };
    },
    /** Get current state. */
    getCurrentState,
    /** Get available height in current column. */
    getAvailableHeight: () => getAvailableHeight(getCurrentState()),
    /** Get content width for the active section. */
    getContentWidth,
    /** Check if height fits in current column. */
    fits: (height: number) => fits(height),
    /** Ensure height fits, advancing if needed. */
    ensureFits,
    /** Add a fragment to current page. */
    addFragment,
    /** Reserve additional footnote area on the current page. */
    addFootnoteHeight,
    /** Force a page break. */
    forcePageBreak,
    /** Force a column break. */
    forceColumnBreak,
    /** Get X position for column. */
    getColumnX,
    /** Update column layout (for section breaks). */
    updateColumns,
    /** Update page size/margins for subsequent pages. */
    updatePageLayout,
    /** Mark the next created page as the first page of a new section. */
    startSection,
  };
}

export type Paginator = ReturnType<typeof createPaginator>;
