import { panic, Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { searchLegislationHandler } from "@/api/handlers/legislation/search";
import {
  searchLegislationBodySchema,
  searchLegislationResponseSchema,
} from "@/api/handlers/legislation/search-schema";
import { status } from "@/api/http/status";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
} from "@/api/lib/api-handlers";
import { paginationLimitSchema } from "@/api/lib/custom-schema";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";

const publicStatuteSearchQuerySchema = v.strictObject({
  ...v.omit(searchLegislationBodySchema, ["jurisdiction", "limit"]).entries,
  country: tPublicLawCountry,
  limit: v.optional(
    numberFromString(
      paginationLimitSchema(LIMITS.publicStatuteSearchPageSizeMax),
    ),
  ),
});

/** The public HTTP boundary delegates retrieval to the shared corpus operation. */
export const createPublicStatuteSearch = (search = searchLegislationHandler) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      cache: { kind: "none" },
      query: publicStatuteSearchQuerySchema,
      response: searchLegislationResponseSchema,
    },
    async function* ({ query: { country, ...query } }) {
      const countryRead = readPublicLawCountry(country, {
        domain: "legislation",
        admitted: PUBLIC_LEGISLATION_COUNTRIES,
        surface: "search",
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
