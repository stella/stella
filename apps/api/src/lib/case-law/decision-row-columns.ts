import { caseLawDecisions } from "@/api/db/schema";
import {
  publisherHeadnoteMetadataSql,
  publisherKeywordsMetadataSql,
} from "@/api/lib/case-law/publisher-summary";

/**
 * The columns one public decision row is made of.
 *
 * The list, the search's hydration and the summaries read all return the same
 * row, and a column added to one of them is a column the other two owe the
 * same reader. Selected from here so the three cannot drift into three shapes
 * of the same thing; a caller that needs more spreads this and adds its own.
 *
 * A function rather than a constant: each query gets its own expressions
 * instead of sharing one set of descriptors across the process.
 */
export const publicDecisionRowColumns = () => ({
  id: caseLawDecisions.id,
  caseNumber: caseLawDecisions.caseNumber,
  caseNumberType: caseLawDecisions.caseNumberType,
  slug: caseLawDecisions.slug,
  ecli: caseLawDecisions.ecli,
  court: caseLawDecisions.court,
  country: caseLawDecisions.country,
  language: caseLawDecisions.language,
  languageGroupKey: caseLawDecisions.languageGroupKey,
  decisionDate: caseLawDecisions.decisionDate,
  decisionType: caseLawDecisions.decisionType,
  sourceUrl: caseLawDecisions.sourceUrl,
  // The publisher's own two kinds, kept apart all the way to the cell.
  headnote: publisherHeadnoteMetadataSql(caseLawDecisions.metadata),
  keywords: publisherKeywordsMetadataSql(caseLawDecisions.metadata),
  citationCount: caseLawDecisions.citationCount,
  createdAt: caseLawDecisions.createdAt,
});
