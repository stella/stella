import { legislationDocuments } from "@/api/db/schema";

/**
 * What every historical read labels a version with, next to its dates: its
 * kind, whether its window can apply, and why not. History keeps every
 * version a publisher lists; these fields are what stop a reader, a model or
 * an agent from taking a stored window for a period the text applied.
 */
export const legislationExpressionLabelColumns = {
  expressionKind: legislationDocuments.expressionKind,
  windowDisposition: legislationDocuments.windowDisposition,
  windowDispositionBasis: legislationDocuments.windowDispositionBasis,
};

/**
 * What an answer naming the versions behind a publisher-data gap reports
 * about each: which version, its language, the window as stated and why it
 * is inconsistent. A display projection only: the gap is decided without it.
 */
export const inconsistentVersionColumns = {
  id: legislationDocuments.id,
  language: legislationDocuments.language,
  versionValidFrom: legislationDocuments.versionValidFrom,
  versionValidTo: legislationDocuments.versionValidTo,
  basis: legislationDocuments.windowDispositionBasis,
};
