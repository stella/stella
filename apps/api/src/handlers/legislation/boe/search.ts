import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import { BOE_SEARCH_PAGE_LIMITS, BoeValidationError } from "@stll/boe";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { boeClient } from "@/api/lib/legal-search/boe-client";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const querySchema = v.object({
  text: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(256),
      v.description("Free-text search over consolidated legislation"),
    ),
  ),
  title: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(256),
      v.description("Filter search results by title text"),
    ),
  ),
  departmentCode: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(32),
      v.description("Filter search results by department code"),
    ),
  ),
  legalRangeCode: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(32),
      v.description("Filter search results by legal-range code (law rank)"),
    ),
  ),
  matterCode: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(32),
      v.description("Filter search results by subject-matter code"),
    ),
  ),
  dateFrom: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{8}$/u),
      v.description("Only laws published on or after this date (YYYYMMDD)"),
    ),
  ),
  dateTo: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{8}$/u),
      v.description("Only laws published on or before this date (YYYYMMDD)"),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d+$/u),
      v.maxLength(5),
      v.description(
        "Opaque cursor from a previous search_boe_legislation call for the next page",
      ),
    ),
  ),
  limit: v.optional(
    v.pipe(
      numberFromString(v.pipe(v.number(), v.minValue(1), v.maxValue(100))),
      v.description("Max search results to return"),
    ),
  ),
});

const boeSearch = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Search Spanish consolidated legislation on the BOE. At least one " +
      "filter is required: free text, title, department code, legal-range " +
      "code (law rank), subject-matter code, or a publication date range as " +
      "YYYYMMDD. Paginate with limit and the opaque cursor. This queries the " +
      "BOE service live; use the search_legislation tool to search the " +
      "stella legislation corpus instead.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "search_boe_legislation" },
    access: "read",
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
          await boeClient(
            grantThirdPartyOutboundPermit(),
          ).searchConsolidatedLegislation({
            ...searchOptions,
            limit: normalizeTenantPageLimit(
              searchOptions.limit ?? BOE_SEARCH_PAGE_LIMITS.default,
            ),
            offset,
          }),
        catch: mapBoeError,
      }),
    );

    return Result.ok(result);
  },
);

export default boeSearch;
