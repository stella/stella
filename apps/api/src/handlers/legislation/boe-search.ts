import { BoeValidationError, searchConsolidatedLegislation } from "@stll/boe";
import { Result } from "better-result";
import { t } from "elysia";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const querySchema = t.Object({
  text: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  title: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  departmentCode: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  legalRangeCode: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  matterCode: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  dateFrom: t.Optional(t.String({ pattern: "^\\d{8}$" })),
  dateTo: t.Optional(t.String({ pattern: "^\\d{8}$" })),
  offset: t.Optional(t.Numeric({ minimum: 0, maximum: 10_000 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});

const boeSearch = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: querySchema,
  },
  async function* ({ query }) {
    const hasFilter =
      query.text ||
      query.title ||
      query.departmentCode ||
      query.legalRangeCode ||
      query.matterCode ||
      query.dateFrom ||
      query.dateTo;

    if (!hasFilter) {
      return Result.err(
        mapBoeError(new BoeValidationError("At least one filter is required")),
      );
    }

    const result = yield* Result.await(
      Result.tryPromise({
        try: async () => await searchConsolidatedLegislation(query),
        catch: mapBoeError,
      }),
    );

    return Result.ok(result);
  },
);

export default boeSearch;
