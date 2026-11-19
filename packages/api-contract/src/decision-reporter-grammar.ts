import { CZ_NS_COLLECTION_GRAMMAR } from "./cz-ns-collection-citation";
import type { DecisionReporterGrammar } from "./decision-query-intent";
import {
  readsUsReporterCitations,
  US_REPORTER_GRAMMAR,
} from "./us-reporter-citation";

/** The jurisdiction whose Supreme Court collection the Czech grammar reads. */
const CZ_NS_COLLECTION_JURISDICTION = "CZE";

/**
 * The reporter grammar a query entry is read with in `jurisdiction`, or null
 * where reporter citations are not read: the United States reporters, and in
 * Czechia the Supreme Court's collection.
 */
export const decisionReporterGrammarForJurisdiction = (
  jurisdiction: string | null | undefined,
): DecisionReporterGrammar | null => {
  if (readsUsReporterCitations(jurisdiction)) {
    return US_REPORTER_GRAMMAR;
  }
  return jurisdiction === CZ_NS_COLLECTION_JURISDICTION
    ? CZ_NS_COLLECTION_GRAMMAR
    : null;
};
