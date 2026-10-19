import { compareByLocale } from "@stll/collation";
import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

type CountryOption = { code: string; name: string };

type FilterJurisdictionOptions<TCountry extends CountryOption> = {
  countries: readonly TCountry[];
  locale: string;
  query: string;
  selectedCodes: readonly string[];
  suggestedCodes: readonly string[];
};

export const filterJurisdictionOptions = <TCountry extends CountryOption>({
  countries,
  locale,
  query,
  selectedCodes,
  suggestedCodes,
}: FilterJurisdictionOptions<TCountry>): TCountry[] => {
  const normalizedQuery = query.trim().toLowerCase();
  const selectedSet = new Set(selectedCodes);
  const suggestedSet = new Set(suggestedCodes);
  const compareName = compareByLocale(locale);
  const sorted = countries.toSorted((a, b) => {
    const aSelected = selectedSet.has(a.code);
    const bSelected = selectedSet.has(b.code);
    if (aSelected !== bSelected) {
      return aSelected ? -1 : 1;
    }

    const aSuggested = suggestedSet.has(a.code);
    const bSuggested = suggestedSet.has(b.code);
    if (aSuggested !== bSuggested) {
      return aSuggested ? -1 : 1;
    }

    return compareName(a.name, b.name);
  });

  if (!normalizedQuery) {
    return sorted;
  }

  return sorted.filter(
    (country) =>
      containsSearchMatchKey(country.name.toLowerCase(), normalizedQuery) ||
      containsSearchMatchKey(country.code.toLowerCase(), normalizedQuery),
  );
};
