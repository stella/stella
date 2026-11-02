import type * as v from "valibot";

import type { caseLawFilterValidationSchema } from "@stll/api-contract/case-law-filter-scope";

import { dropCaseLawFilters } from "@/features/case-law/case-law-index-search.logic";
import { toCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";

import type { CaseLawIndexSearch } from "./-case-law-search-schema";

type CorrectedCaseLawFilterSearchOptions<TSearch extends CaseLawIndexSearch> = {
  search: TSearch;
  country: string;
  validation: v.InferOutput<typeof caseLawFilterValidationSchema>;
};

/** Keep the search context while making invalid facets and their removal explicit. */
export const correctedCaseLawFilterSearch = <
  TSearch extends CaseLawIndexSearch,
>({
  search,
  country,
  validation,
}: CorrectedCaseLawFilterSearchOptions<TSearch>) => {
  if (validation.removed.length === 0) {
    return null;
  }
  return {
    ...dropCaseLawFilters(
      search,
      validation.removed.map(({ field }) => field),
    ),
    country: toCaseLawCountryParam(country),
    page: undefined,
    filterNotice: validation.removed,
  };
};
