export type ScrollPageInfo = {
  currentPage: number;
  totalPages: number;
  visible: boolean;
};

export const updateScrollPageTotal = (
  previous: ScrollPageInfo,
  totalPages: number,
): ScrollPageInfo => ({
  ...previous,
  currentPage: Math.min(previous.currentPage, totalPages),
  totalPages,
});
