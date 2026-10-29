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
