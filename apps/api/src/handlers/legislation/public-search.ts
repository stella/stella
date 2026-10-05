import { panic, Result } from "better-result";
import { status, t } from "elysia";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import {
  searchLegislationBodySchema,
  searchLegislationResponseSchema,
} from "@/api/handlers/legislation/search-schema";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
} from "@/api/lib/api-handlers";
import { tPaginationLimit } from "@/api/lib/custom-schema";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";

const publicStatuteSearchQuerySchema = t.Object(
  {
    ...t.Omit(searchLegislationBodySchema, ["jurisdiction", "limit"])
      .properties,
    country: tPublicLawCountry,
    limit: t.Optional(tPaginationLimit(LIMITS.publicStatuteSearchPageSizeMax)),
  },
  { additionalProperties: false },
);

/** The public HTTP boundary delegates retrieval to the shared corpus operation. */
export const createPublicStatuteSearch = (search = searchLegislationHandler) =>
  createSafeBoundedPublicHandler(
    {
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      cache: { kind: "none" },
      query: publicStatuteSearchQuerySchema,
      response: searchLegislationResponseSchema,
    },
    async function* ({ query: { country, ...query } }) {
      const countryRead = readPublicLawCountry(country, {
        admitted: PUBLIC_LEGISLATION_COUNTRIES,
      });
      const response = yield* Result.await(
        Result.tryPromise(async () => {
          switch (countryRead.kind) {
            case "unavailable":
              return countryRead.answer;
            case "unreadable":
              return status(400, { message: countryRead.message });
            case "read":
              return await search(
                {
                  ...query,
                  jurisdiction: countryRead.country,
                  limit: query.limit ?? LIMITS.publicStatuteSearchPageSizeMax,
                },
                legislationPublicReadDb,
                "unobserved",
              );
            default:
              countryRead satisfies never;
              return panic("Unhandled public statute country state");
          }
        }),
      );
      return Result.ok(response);
    },
  );

export default createPublicStatuteSearch();
