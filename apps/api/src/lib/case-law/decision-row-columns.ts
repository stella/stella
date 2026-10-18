import { publishedCaseLawDecisions } from "@/api/db/schema";
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
  id: publishedCaseLawDecisions.id,
  caseNumber: publishedCaseLawDecisions.caseNumber,
  caseNumberType: publishedCaseLawDecisions.caseNumberType,
  slug: publishedCaseLawDecisions.slug,
  ecli: publishedCaseLawDecisions.ecli,
  court: publishedCaseLawDecisions.court,
  // A directory court is presented by its id's rank, not by its name.
  courtId: publishedCaseLawDecisions.courtId,
  country: publishedCaseLawDecisions.country,
  language: publishedCaseLawDecisions.language,
  languageGroupKey: publishedCaseLawDecisions.languageGroupKey,
  decisionDate: publishedCaseLawDecisions.decisionDate,
  decisionType: publishedCaseLawDecisions.decisionType,
  sourceUrl: publishedCaseLawDecisions.sourceUrl,
  // The publisher's own two kinds, kept apart all the way to the cell.
  headnote: publisherHeadnoteMetadataSql(publishedCaseLawDecisions.metadata),
  keywords: publisherKeywordsMetadataSql(publishedCaseLawDecisions.metadata),
  citationCount: publishedCaseLawDecisions.citationCount,
  createdAt: publishedCaseLawDecisions.createdAt,
});
