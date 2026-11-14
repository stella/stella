import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

type CaseFileDocument = PublicCaseLawDecision["caseFile"]["items"][number];

/** The open decision, or its translation: one document in another language. */
export const isCurrentCaseFileDocument = (
  document: Pick<CaseFileDocument, "id" | "languageGroupKey">,
  decision: Pick<PublicCaseLawDecision, "id" | "languageGroupKey">,
): boolean =>
  document.id === decision.id ||
  (document.languageGroupKey !== null &&
    document.languageGroupKey === decision.languageGroupKey);

/**
 * Whether the case file has anything to navigate to: a document other than the
 * open decision (and its translations) on this page, or a further page. A case
 * file holding only the open decision lists nothing the reader is not already
 * reading, so it is not shown.
 */
export const hasOtherCaseFileDocuments = (
  caseFile: Pick<PublicCaseLawDecision["caseFile"], "nextCursor"> & {
    items: readonly Pick<CaseFileDocument, "id" | "languageGroupKey">[];
  },
  decision: Pick<PublicCaseLawDecision, "id" | "languageGroupKey">,
): boolean =>
  caseFile.nextCursor !== null ||
  caseFile.items.some(
    (document) => !isCurrentCaseFileDocument(document, decision),
  );

type CaseFileRouteLocation = {
  pathname: string;
  /** The raw query string, with or without its leading `?`. */
  search: string;
  /** The fragment without its `#`. */
  hash: string;
};

/** This page with the next case-file cursor; every other parameter is kept. */
export const caseFileNextPageHref = (
  { pathname, search, hash }: CaseFileRouteLocation,
  nextCursor: string,
): string => {
  const params = new URLSearchParams(search);
  params.set("caseFileCursor", nextCursor);
  return `${pathname}?${params.toString()}${hash === "" ? "" : `#${hash}`}`;
};
