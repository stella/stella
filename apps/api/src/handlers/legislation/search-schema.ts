import { FormatRegistry } from "@sinclair/typebox";
import { t } from "elysia";
import type { Static } from "elysia";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";
import { LEGISLATION_SEARCH_MATCH_TYPES } from "@stll/api-contract/search";

import {
  safeHandlerErrorResponseSchema,
  safeHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import { CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { tPublicCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import { searchTotalSchema } from "@/api/lib/search/total-schema";

export const PUBLIC_JURISDICTIONS_DESCRIPTION =
  `Admitted jurisdiction codes (uppercase): ${PUBLIC_LEGISLATION_COUNTRIES.join(", ")}. ` +
  "Omit jurisdiction to search all admitted jurisdictions.";

/** Search the public legislation corpus and return legislation-shaped items. */
export const searchLegislationBodySchema = t.Object({
  query: t.String({ minLength: 1, maxLength: LIMITS.searchQueryMaxLength }),
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  // A continuation past a capped scan window carries the acts it already
  // showed, so the cursor may be longer than a bare keyset.
  cursor: t.Optional(
    tPaginationCursor({
      maxChars: CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
    }),
  ),
  jurisdiction: t.Optional(
    t.String({ maxLength: 3, description: PUBLIC_JURISDICTIONS_DESCRIPTION }),
  ),
  documentType: t.Optional(t.String({ maxLength: 128 })),
  status: t.Optional(t.String({ maxLength: 32 })),
  source: t.Optional(tSafeId("legislationSource")),
  language: t.Optional(t.String({ maxLength: 8 })),
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
});

export type SearchLegislationBody = Static<typeof searchLegislationBodySchema>;

const boundedString = (maxBytes: number) => {
  const format = `legislation-search-utf8-${maxBytes}`;
  if (!FormatRegistry.Has(format)) {
    FormatRegistry.Set(
      format,
      (value) =>
        value.isWellFormed() && Buffer.byteLength(value, "utf-8") <= maxBytes,
    );
  }
  return t.String({
    maxLength: maxBytes,
    format,
    "x-maxUtf8Bytes": maxBytes,
    description: `At most ${maxBytes} UTF-8 bytes.`,
  });
};

const nullableBoundedString = (maxBytes: number) =>
  t.Union([boundedString(maxBytes), t.Null()]);

const textBytes = LIMITS.legislationSearchTextBytes;

export const searchLegislationSuccessResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          match: t.Object(
            {
              type: t.UnionEnum(LEGISLATION_SEARCH_MATCH_TYPES),
            },
            { additionalProperties: false },
          ),
          documentId: boundedString(textBytes.documentId),
          eli: boundedString(textBytes.eli),
          slug: nullableBoundedString(textBytes.slug),
          title: boundedString(textBytes.title),
          country: boundedString(textBytes.country),
          language: boundedString(textBytes.language),
          documentType: nullableBoundedString(textBytes.documentType),
          status: boundedString(textBytes.status),
          effectiveDate: nullableBoundedString(textBytes.effectiveDate),
          sourceUrl: nullableBoundedString(textBytes.sourceUrl),
          headline: nullableBoundedString(textBytes.headline),
          score: t.Number(),
        },
        { additionalProperties: false },
      ),
    ),
    nextCursor: nullableBoundedString(
      CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH,
    ),
    total: searchTotalSchema,
  },
  { additionalProperties: false },
);

export const searchLegislationResponseSchema = {
  ...safeHandlerResponseSchemasWithStatusText(
    searchLegislationSuccessResponseSchema,
  ),
  503: t.Union([safeHandlerErrorResponseSchema, tPublicCountryUnavailable]),
};
