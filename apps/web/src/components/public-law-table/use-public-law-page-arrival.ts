import { useRef } from "react";
import type { RefObject } from "react";

import { WORKSPACE_TABLE_SCROLL_SLOT } from "@/components/workspaces/table/workspace-grid";
import { useExternalSyncEffect } from "@/hooks/use-effect";

const RESULTS_SCROLLER_SELECTOR = `[data-slot="${WORKSPACE_TABLE_SCROLL_SLOT}"]`;
/** The page's first result: the row the table numbers first. */
const FIRST_RESULT_SELECTOR = `${RESULTS_SCROLLER_SELECTOR} [role="row"][data-index="0"]`;

const focusFirstResult = (region: HTMLElement): boolean => {
  const row = region.querySelector<HTMLElement>(FIRST_RESULT_SELECTOR);
  if (row === null) {
    return false;
  }
  // Focus brings the row into view in every scroller that still hides it,
  // which covers the page's own scroller on a viewport too short for the
  // table.
  row.focus();
  return true;
};

/**
 * Brings the reader to the first row of the results in `region`: the table's
 * scroller back to the top, focus on the first row. The table draws only the
 * rows near its scroll position, so after a deep scroll the first row exists
 * only once the table has redrawn at the top; one frame later it does.
 */
const moveToFirstResult = (
  region: HTMLElement,
  focusOnArrival: "first-result" | "preserve",
): void => {
  for (const scroller of region.querySelectorAll<HTMLElement>(
    RESULTS_SCROLLER_SELECTOR,
  )) {
    scroller.scrollTop = 0;
  }
  if (focusOnArrival === "preserve") {
    return;
  }
  if (!focusFirstResult(region)) {
    requestAnimationFrame(() => {
      focusFirstResult(region);
    });
  }
};

type UsePublicLawPageArrivalInput = {
  focusOnArrival: "first-result" | "preserve";
  /** The results region: the table and the pager under it. */
  regionRef: RefObject<HTMLElement | null>;
  /**
   * The page whose rows are drawn, or null while the rows on screen still
   * belong to another page (a step in flight).
   */
  shownPage: number | null;
};

/**
 * A step to another page moves the reader there: once the next page is
 * drawn (including a redirect), its first row is at the top. The owning route
 * chooses whether focus follows the rows or stays on the pager.
 *
 * Only a pager request moves them. A filter, a sort or a fresh
 * arrival also draws a page, and taking focus from the control the reader is
 * using would be the opposite of help. Returns what the pager calls when the
 * reader follows a link to a page.
 */
export const usePublicLawPageArrival = ({
  focusOnArrival,
  regionRef,
  shownPage,
}: UsePublicLawPageArrivalInput) => {
  const requestedPageRef = useRef<number | null>(null);

  useExternalSyncEffect(() => {
    const region = regionRef.current;
    if (shownPage === null || region === null) {
      return;
    }
    const requested = requestedPageRef.current;
    // The next drawn page settles the request, including a redirect past
    // the end. Clear it before moving focus so later draws cannot reuse it.
    requestedPageRef.current = null;
    if (requested !== null) {
      moveToFirstResult(region, focusOnArrival);
    }
  }, [focusOnArrival, regionRef, shownPage]);

  return (page: number) => {
    requestedPageRef.current = page;
  };
};
