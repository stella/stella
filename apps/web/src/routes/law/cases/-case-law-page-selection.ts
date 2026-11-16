import { useState } from "react";

import { selectionShownOnPage } from "@/components/workspaces/ai-column-run.logic";

const EMPTY_SELECTION: readonly string[] = [];

/**
 * The rows picked on this page. Picked rows narrow a run to them; the page
 * they belong to is the only page they mean anything on, so a step forward
 * clears them, and a new answer on the same page keeps only the picks it
 * still shows (see {@link selectionShownOnPage}). The page's rows stay drawn
 * while another answer is in flight, so a pending search trims nothing.
 */
export const usePageSelection = (
  currentPage: number,
  pageDecisionIds: readonly string[],
) => {
  const [selectedIds, setSelectedIds] =
    useState<readonly string[]>(EMPTY_SELECTION);
  const [selectionPage, setSelectionPage] = useState(currentPage);
  if (selectionPage !== currentPage) {
    setSelectionPage(currentPage);
    setSelectedIds(EMPTY_SELECTION);
    return [EMPTY_SELECTION, setSelectedIds] as const;
  }
  const shown = selectionShownOnPage({
    pageRowIds: pageDecisionIds,
    selectedRowIds: selectedIds,
  });
  if (shown !== null) {
    setSelectedIds(shown);
  }
  return [selectedIds, setSelectedIds] as const;
};
