import type { SearchMatchSummary } from "@/lib/search-match-navigation";

export type OpenDocxFindState = {
  status: "open";
  activeIndex: number;
  focusSeq: number;
  query: string;
  summary: SearchMatchSummary;
};

export const EMPTY_DOCX_FIND_SUMMARY = {
  count: 0,
  truncated: false,
} as const satisfies SearchMatchSummary;

/** Invalidate navigation immediately while the replacement query debounces. */
export const resetOpenDocxFindQuery = (
  state: OpenDocxFindState,
  query: string,
): OpenDocxFindState => ({
  ...state,
  activeIndex: 0,
  query,
  summary: EMPTY_DOCX_FIND_SUMMARY,
});
