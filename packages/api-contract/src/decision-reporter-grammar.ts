import { canonicalCzNsCollectionCitation } from "./cz-ns-collection-citation";
import { foldDecisionIdentifierInput } from "./decision-docket-grammar";
import type { DecisionReporterGrammar } from "./decision-query-intent";
import {
  readsUsReporterCitations,
  US_REPORTER_GRAMMAR,
} from "./us-reporter-citation";

/** The printed NSS citation embedded in publisher labels and read as a whole entry in search. */
export const CZ_NSS_REPORTER_SOURCE = String.raw`[čc]\.\s*([1-9]\d{0,4})\s*\/\s*(\d{4})\s+Sb\.\s*NSS(?![\p{L}\d])`;

const NSS_ENTRY = new RegExp(`^${CZ_NSS_REPORTER_SOURCE}$`, "iu");
const CZECH_COLLECTIONS: DecisionReporterGrammar = {
  canonicalCitation: (text) => {
    const nss = NSS_ENTRY.exec(foldDecisionIdentifierInput(text));
    return nss === null
      ? canonicalCzNsCollectionCitation(text)
      : `č. ${nss[1]}/${nss[2]} Sb. NSS`;
  },
};

/** Older NSS identifiers keep either spelling of the printed number marker. */
export const czechReporterLookupSpellings = (
  value: string,
): readonly string[] =>
  NSS_ENTRY.test(value) ? [value, value.replace(/^č/iu, "c")] : [value];

export const decisionReporterGrammarForJurisdiction = (
  jurisdiction: string | null | undefined,
): DecisionReporterGrammar | null => {
  if (readsUsReporterCitations(jurisdiction)) {
    return US_REPORTER_GRAMMAR;
  }
  return jurisdiction === "CZE" ? CZECH_COLLECTIONS : null;
};
