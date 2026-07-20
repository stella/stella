import { Result } from "better-result";
import { t } from "elysia";

import { BoeValidationError, searchConsolidatedLegislation } from "@stll/boe";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const querySchema = t.Object({
  text: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 256,
      description: "Free-text search over consolidated legislation",
    }),
  ),
  title: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 256,
      description: "Filter search results by title text",
    }),
  ),
  departmentCode: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 32,
      description: "Filter search results by department code",
    }),
  ),
  legalRangeCode: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 32,
      description: "Filter search results by legal-range code (law rank)",
    }),
  ),
  matterCode: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 32,
      description: "Filter search results by subject-matter code",
    }),
  ),
  dateFrom: t.Optional(
    t.String({
      pattern: "^\\d{8}$",
      description: "Only laws published on or after this date (YYYYMMDD)",
    }),
  ),
  dateTo: t.Optional(
    t.String({
      pattern: "^\\d{8}$",
      description: "Only laws published on or before this date (YYYYMMDD)",
    }),
  ),
  cursor: t.Optional(
    t.String({
      pattern: "^\\d+$",
      maxLength: 5,
      description:
        "Opaque cursor from a previous search_legislation call for the next page",
    }),
  ),
  limit: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: 100,
      description: "Max search results to return",
    }),
  ),
});

const boeSearch = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    mcp: { type: "tool", name: "search_legislation" },
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

    const { cursor, ...searchOptions } = query;
    const offset =
      cursor === undefined ? undefined : Number.parseInt(cursor, 10);

    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await searchConsolidatedLegislation({
            ...searchOptions,
            offset,
          }),
        catch: mapBoeError,
      }),
    );

    return Result.ok(result);
  },
);

export default boeSearch;
