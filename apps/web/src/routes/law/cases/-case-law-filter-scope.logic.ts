import type * as v from "valibot";

import type { caseLawFilterValidationSchema } from "@stll/api-contract/case-law-filter-scope";

import { toCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";

import type { CaseLawIndexSearch } from "./-case-law-search-schema";

type CorrectedCaseLawFilterSearchOptions = {
  search: CaseLawIndexSearch;
  country: string;
  validation: v.InferOutput<typeof caseLawFilterValidationSchema>;
};

/** Keep the search context while making invalid facets and their removal explicit. */
export const correctedCaseLawFilterSearch = ({
  search,
  country,
  validation,
}: CorrectedCaseLawFilterSearchOptions): CaseLawIndexSearch | null => {
  if (validation.removed.length === 0) {
    return null;
  }
  return {
    ...search,
    country: toCaseLawCountryParam(country),
    court: validation.filters.court,
    lang: validation.filters.lang,
    type: validation.filters.type,
    sourceId: validation.filters.sourceId,
    page: undefined,
    filterNotice: validation.removed,
  };
};
