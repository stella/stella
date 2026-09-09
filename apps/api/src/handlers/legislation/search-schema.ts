import { t } from "elysia";

import { safeHandlerResponseSchemasWithStatusText } from "@/api/lib/api-handlers";
import { searchTotalSchema } from "@/api/lib/search/total-schema";

const nullableStringSchema = t.Union([t.String(), t.Null()]);

export const searchLegislationSuccessResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          documentId: t.String(),
          eli: t.String(),
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
