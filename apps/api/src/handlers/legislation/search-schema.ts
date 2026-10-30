import * as v from "valibot";

import {
  API_CALENDAR_DATE_CHECK,
  apiDateSchema,
} from "@stll/api-contract/api-date";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import { LEGISLATION_SEARCH_MATCH_TYPES } from "@stll/api-contract/search";

import { safePublicHandlerResponseSchemasWithStatusText } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { withPublicCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import { searchPaginationOutcomeSchema } from "@/api/lib/search/pagination-outcome-schema";
import {
  boundedString,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";
import { searchTotalSchema } from "@/api/lib/search/total-schema";

export const PUBLIC_JURISDICTIONS_DESCRIPTION =
  `Admitted jurisdiction codes (uppercase): ${PUBLIC_LEGISLATION_COUNTRIES.join(", ")}. ` +
  "Omit jurisdiction to search all admitted jurisdictions.";

/** Search the public legislation corpus and return legislation-shaped items. */
export const searchLegislationBodySchema = v.object({
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
  ),
  limit: v.optional(paginationLimitSchema(LIMITS.caseLawSearchPageSizeMax)),
  cursor: v.optional(
    paginationCursorSchema({
      maxChars: CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
    }),
  ),
  jurisdiction: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(3),
      v.description(PUBLIC_JURISDICTIONS_DESCRIPTION),
    ),
  ),
  documentType: v.optional(v.pipe(v.string(), v.maxLength(128))),
  status: v.optional(v.pipe(v.string(), v.maxLength(32))),
  source: v.optional(resourceIdSchema("legislationSource")),
  language: v.optional(v.pipe(v.string(), v.maxLength(8))),
  dateFrom: v.optional(apiDateSchema),
  dateTo: v.optional(apiDateSchema),
  asOf: v.optional(
    v.pipe(
      v.string(),
      v.isoDate(),
      API_CALENDAR_DATE_CHECK,
      v.description(
        "Search the consolidation in force on this date; omitted dates include historical wording.",
      ),
    ),
  ),
});

export type SearchLegislationBody = v.InferOutput<
  typeof searchLegislationBodySchema
>;

const textBytes = LIMITS.legislationSearchTextBytes;

export const searchLegislationSuccessResponseSchema = v.object({
  items: v.array(
    v.object({
      match: v.object({ type: v.picklist(LEGISLATION_SEARCH_MATCH_TYPES) }),
      documentId: boundedString(textBytes.documentId),
      eli: boundedString(textBytes.eli),
      slug: nullableBoundedString(textBytes.slug),
      title: boundedString(textBytes.title),
      country: boundedString(textBytes.country),
      language: boundedString(textBytes.language),
      documentType: nullableBoundedString(textBytes.documentType),
      status: boundedString(textBytes.status),
      effectiveDate: nullableBoundedString(textBytes.effectiveDate),
      versionValidFrom: nullableBoundedString(textBytes.versionValidFrom),
      versionValidTo: nullableBoundedString(textBytes.versionValidTo),
      sourceUrl: nullableBoundedString(textBytes.sourceUrl),
      headline: nullableBoundedString(textBytes.headline),
      score: v.number(),
    }),
  ),
  nextCursor: nullableBoundedString(CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH),
  paginationOutcome: searchPaginationOutcomeSchema,
  total: searchTotalSchema,
});

export const searchLegislationResponseSchema = withPublicCountryUnavailable(
  safePublicHandlerResponseSchemasWithStatusText(
    searchLegislationSuccessResponseSchema,
  ),
);
