import { t } from "elysia";
import type { Static } from "elysia";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { safeHandlerResponseSchemasWithStatusText } from "@/api/lib/api-handlers";
import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { searchTotalSchema } from "@/api/lib/search/total-schema";

export const PUBLIC_JURISDICTIONS_DESCRIPTION =
  `Admitted jurisdiction codes (uppercase): ${PUBLIC_LEGISLATION_COUNTRIES.join(", ")}. ` +
  "Omit jurisdiction to search all admitted jurisdictions.";

/** Search the public legislation corpus and return legislation-shaped items. */
export const searchLegislationBodySchema = t.Object({
  query: t.String({ minLength: 1, maxLength: LIMITS.searchQueryMaxLength }),
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
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

const nullableStringSchema = t.Union([t.String(), t.Null()]);

export const searchLegislationSuccessResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          documentId: t.String(),
          eli: t.String(),
          slug: nullableStringSchema,
          title: t.String(),
          country: t.String(),
          language: t.String(),
          documentType: nullableStringSchema,
          status: t.String(),
          effectiveDate: nullableStringSchema,
          sourceUrl: nullableStringSchema,
          headline: nullableStringSchema,
          score: t.Number(),
        },
        { additionalProperties: false },
      ),
    ),
    nextCursor: nullableStringSchema,
    total: searchTotalSchema,
  },
  { additionalProperties: false },
);

export const searchLegislationResponseSchema =
  safeHandlerResponseSchemasWithStatusText(
    searchLegislationSuccessResponseSchema,
  );
