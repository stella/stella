import { getPDFPageIdByNumber } from "@/lib/pdf/utils";

type PendingPdfPageScroll = {
  tabId: string;
  pageNumber: number;
} | null;

/** Resolve a queued citation only after the exact viewer has loaded the cited
 * page. Returning undefined keeps the command pending across lazy mount and
 * prevents another mounted file from consuming it. */
export const resolvePendingPdfCitationPageId = ({
  fieldId,
  pages,
  request,
}: {
  fieldId: string;
  pages: Map<string, unknown>;
  request: PendingPdfPageScroll;
}): string | undefined => {
  if (request?.tabId !== fieldId) {
    return undefined;
  }
  return getPDFPageIdByNumber({
    fieldId,
    pages,
    pageNumber: request.pageNumber,
  });
};
