import { panic } from "better-result";
import type { Static } from "elysia";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { DECISION_TYPE_KINDS } from "@stll/api-contract/case-law-decision-types";
import { CASE_LAW_SEARCH_WARNING_CODES } from "@stll/api-contract/search";
import { DECISION_IDENTIFIER_MAX_COUNT } from "@stll/legal-ast/decision-identifier";

import { CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { LIMITS } from "@/api/lib/limits";
import {
  truncateHeadlineBytes,
  nullableText,
  truncateTextBytes,
} from "@/api/lib/search/response-text-bounds";

import { CASE_SEARCH_TEXT_BYTES as bytes } from "./search-response-limits";
import type { searchDecisionsSuccessResponseSchema } from "./search-schema";

type SearchResponse = Static<typeof searchDecisionsSuccessResponseSchema>;
type SearchHit = SearchResponse["hits"][number];
const projectHeadnote = (
  headnote: SearchHit["headnote"],
): SearchHit["headnote"] => {
  switch (headnote.type) {
    case "absent":
      return headnote;
    case "present": {
      const text = truncateTextBytes(
        headnote.text,
        LIMITS.caseLawHeadnoteMaxChars * 4,
      );
      return {
        type: "present",
        text,
        truncated: headnote.truncated || text !== headnote.text,
      };
    }
    case "keywords":
      return {
        type: "keywords",
        items: headnote.items
          .slice(0, LIMITS.caseLawHeadnoteKeywords)
          .map((text) =>
            truncateTextBytes(text, LIMITS.caseLawHeadnoteMaxChars * 4),
          ),
        omitted:
          headnote.omitted +
          Math.max(0, headnote.items.length - LIMITS.caseLawHeadnoteKeywords),
      };
    default: {
      headnote satisfies never;
      return panic(`Unhandled headnote: ${String(headnote)}`);
    }
  }
};

const projectIdentifiers = ([
  first,
  ...remaining
]: SearchHit["identifiers"]): SearchHit["identifiers"] => [
  { type: first.type, value: truncateTextBytes(first.value, bytes.identifier) },
  ...remaining
    .slice(0, DECISION_IDENTIFIER_MAX_COUNT - 1)
    .map((identifier) => ({
      type: identifier.type,
      value: truncateTextBytes(identifier.value, bytes.identifier),
    })),
];

const projectHit = (hit: SearchHit): SearchHit => ({
  decisionId: truncateTextBytes(hit.decisionId, bytes.id),
  caseNumber: truncateTextBytes(hit.caseNumber, bytes.caseNumber),
  caseNumberType: hit.caseNumberType,
  slug: nullableText(hit.slug, bytes.slug),
  ecli: nullableText(hit.ecli, bytes.identifier),
  identifiers: projectIdentifiers(hit.identifiers),
  court: truncateTextBytes(hit.court, bytes.court),
  courtAbbreviation: nullableText(
    hit.courtAbbreviation,
    bytes.courtAbbreviation,
  ),
  courtTier: hit.courtTier,
  country: truncateTextBytes(hit.country, bytes.country),
  language: truncateTextBytes(hit.language, bytes.language),
  languageAlternates: hit.languageAlternates
    .slice(0, LIMITS.caseLawLanguageAlternatesPerGroupMax)
    .map((alternate) => ({
      caseNumber: truncateTextBytes(alternate.caseNumber, bytes.caseNumber),
      country: truncateTextBytes(alternate.country, bytes.country),
      court: truncateTextBytes(alternate.court, bytes.court),
      decisionDate: nullableText(alternate.decisionDate, bytes.date),
      id: truncateTextBytes(alternate.id, bytes.id),
      language: truncateTextBytes(alternate.language, bytes.language),
      slug: nullableText(alternate.slug, bytes.slug),
    })),
  decisionDate: nullableText(hit.decisionDate, bytes.date),
  decisionType: nullableText(hit.decisionType, bytes.decisionType),
  sourceUrl: nullableText(hit.sourceUrl, bytes.sourceUrl),
  headnote: projectHeadnote(hit.headnote),
  headline:
    hit.headline === null
      ? null
      : truncateHeadlineBytes(hit.headline, bytes.headline),
  anchorId: nullableText(hit.anchorId, bytes.anchorId),
  citationCount: hit.citationCount,
  citationAuthority: hit.citationAuthority,
  matchingPassages: hit.matchingPassages,
  createdAt: truncateTextBytes(hit.createdAt, bytes.date),
});

type FacetBucket = NonNullable<SearchResponse["facets"]>["year"][number];
const projectBucket = (bucket: FacetBucket) => ({
  value: truncateTextBytes(bucket.value, bytes.facet),
  label: nullableText(bucket.label, bytes.label),
  count: bucket.count,
});

// Both backends pass their entire successful envelope through this boundary.
export const projectCaseLawSearchResponse = (
  response: SearchResponse,
): SearchResponse => ({
  hits: response.hits.slice(0, LIMITS.caseLawSearchPageSizeMax).map(projectHit),
  facets:
    response.facets === null
      ? null
      : {
          courtYear: response.facets.courtYear,
          court: response.facets.court
            .slice(0, COURT_TIER_LABELS.length)
            .map((tier) => ({
              tierLabel: tier.tierLabel,
              courts: tier.courts
                .slice(0, LIMITS.caseLawFacetLimit)
                .map(projectBucket),
            })),
          year: response.facets.year
            .slice(0, LIMITS.caseLawYearFacetLimit)
            .map(projectBucket),
          // A kind is a short closed value, so only the label needs bounding.
          decisionType: response.facets.decisionType
            .slice(0, DECISION_TYPE_KINDS.length)
            .map(({ count, label, value }) => ({
              value,
              label: nullableText(label, bytes.label),
              count,
            })),
          source: response.facets.source
            .slice(0, LIMITS.caseLawYearFacetLimit)
            .map((bucket) =>
              Object.assign(projectBucket(bucket), {
                countType: bucket.countType,
              }),
            ),
          language: response.facets.language
            .slice(0, LIMITS.caseLawYearFacetLimit)
            .map(projectBucket),
        },
  total: response.total,
  nextCursor: nullableText(
    response.nextCursor,
    CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH,
  ),
  paginationOutcome: response.paginationOutcome,
  queryUsed: truncateTextBytes(response.queryUsed, bytes.queryUsed),
  warnings: response.warnings
    .slice(0, CASE_LAW_SEARCH_WARNING_CODES.length)
    .map((warning) => ({
      code: warning.code,
      message: truncateTextBytes(warning.message, bytes.warning),
      hint: truncateTextBytes(warning.hint, bytes.warning),
    })),
});
