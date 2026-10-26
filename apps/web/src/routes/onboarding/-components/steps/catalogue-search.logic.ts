import { createSearchQueryMatcher } from "@stll/text-normalize/search-query-matcher";

type SearchableCatalogueEntry = {
  description: string;
  displayName: string;
  jurisdictions: readonly string[];
  tags: readonly string[];
};

type FilterCatalogueEntriesOptions<T extends SearchableCatalogueEntry> = {
  compareName: (left: string, right: string) => number;
  jurisdictionFilter: ReadonlySet<string>;
  localizedName: (entry: T) => string;
  otherEntries: readonly T[];
  query: string;
  recommendedEntries: readonly T[];
};

export const filterOnboardingCatalogueEntries = <
  T extends SearchableCatalogueEntry,
>({
  compareName,
  jurisdictionFilter,
  localizedName,
  otherEntries,
  query,
  recommendedEntries,
}: FilterCatalogueEntriesOptions<T>): T[] => {
  const matches = createSearchQueryMatcher(query);
  const matchesSearch = (entry: T) => {
    if (jurisdictionFilter.size > 0 && entry.jurisdictions.length > 0) {
      const hasMatch = entry.jurisdictions.some((code) =>
        jurisdictionFilter.has(code),
      );
      if (!hasMatch) {
        return false;
      }
    }
    return (
      matches(entry.displayName) ||
      matches(localizedName(entry)) ||
      matches(entry.description) ||
      entry.tags.some(matches)
    );
  };

  return [...recommendedEntries, ...otherEntries]
    .filter(matchesSearch)
    .toSorted((left, right) =>
      compareName(localizedName(left), localizedName(right)),
    );
};
