import * as v from "valibot";

import { caseLawScopedFiltersSchema } from "@stll/api-contract/case-law-filter-scope";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import { status } from "@/api/http/status";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readCaseLawFilterScope } from "@/api/lib/case-law/filter-country-scope";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";

export const decisionFilterValidationQuerySchema = v.object({
  country: tPublicLawCountry,
  ...caseLawScopedFiltersSchema.entries,
});

export const decisionFilterValidationHandler = async ({
  country,
  ...filters
}: v.InferOutput<typeof decisionFilterValidationQuerySchema>) => {
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
    caseLawDb: caseLawPublicReadDb,
  });
};
