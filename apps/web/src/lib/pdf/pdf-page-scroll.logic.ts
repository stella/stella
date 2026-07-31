import type { PDFScrollTo } from "@/lib/pdf/pdf-context";

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

type IsPDFSearchMatchScrollRequestArgs = {
  matchIndex: number;
  pageId: string;
  scrollTo: PDFScrollTo | null;
};

export const isPDFSearchMatchScrollRequest = ({
  matchIndex,
  pageId,
  scrollTo,
}: IsPDFSearchMatchScrollRequestArgs): boolean =>
  scrollTo?.pageId === pageId &&
  scrollTo.target?.kind === "searchMatch" &&
  scrollTo.target.matchIndex === matchIndex;
