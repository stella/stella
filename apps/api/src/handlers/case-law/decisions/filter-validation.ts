import { Result } from "better-result";
import * as v from "valibot";

import {
  caseLawFilterValidationSchema,
  caseLawScopedFiltersSchema,
} from "@stll/api-contract/case-law-filter-scope";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import { status } from "@/api/http/status";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readCaseLawFilterScope } from "@/api/lib/case-law/filter-country-scope";
import {
  readPublicLawCountry,
  tPublicLawCountry,
  withPublicCountryUnavailable,
} from "@/api/lib/legal-search/public-law-country";
import { projectResponseText } from "@/api/lib/search/project-response-text";

export const decisionFilterValidationQuerySchema = v.object({
  country: tPublicLawCountry,
  ...caseLawScopedFiltersSchema.entries,
});

const decisionFilterValidationHandler = async (
  {
    country,
    ...filters
  }: v.InferOutput<typeof decisionFilterValidationQuerySchema>,
  caseLawDb = caseLawPublicReadDb,
) => {
  const read = readPublicLawCountry(country, {
    domain: "caseLaw",
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    surface: "search",
  });
  if (read.kind === "unavailable") {
    return read.answer;
  }
  if (read.kind === "unreadable") {
    return status(400, { message: read.message });
  }
  const scope = publicCaseLawCountry(read.country);
  if (scope === null) {
    return status(404, { message: "Not Found" });
  }
  return await readCaseLawFilterScope({
    country: scope,
    filters,
    caseLawDb,
  });
};

export const createDecisionFilterValidationRoute = (
  caseLawDb = caseLawPublicReadDb,
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      cache: { kind: "none" },
      response: withPublicCountryUnavailable(
        safePublicHandlerResponseSchemasWithStatusText(
          caseLawFilterValidationSchema,
        ),
      ),
      query: decisionFilterValidationQuerySchema,
    },
    async function* ({ query }) {
      const response = yield* Result.await(
        Result.tryPromise(
          async () => await decisionFilterValidationHandler(query, caseLawDb),
        ),
      );
      return Result.ok(
        projectResponseText(response, caseLawFilterValidationSchema),
      );
    },
  );

const validateDecisionFilters = createDecisionFilterValidationRoute();

export default validateDecisionFilters;
