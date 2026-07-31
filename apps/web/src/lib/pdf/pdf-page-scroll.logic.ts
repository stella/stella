type GetPDFPageScrollTopArgs = {
  currentScrollTop: number;
  pageTop: number;
  viewportTop: number;
};

export const getPDFPageScrollTop = ({
  currentScrollTop,
  pageTop,
  viewportTop,
}: GetPDFPageScrollTopArgs) => currentScrollTop + pageTop - viewportTop;
