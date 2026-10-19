import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

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
  const normalised = query.trim().toLowerCase();
  const matchesSearch = (entry: T) => {
    if (jurisdictionFilter.size > 0 && entry.jurisdictions.length > 0) {
      const hasMatch = entry.jurisdictions.some((code) =>
        jurisdictionFilter.has(code),
      );
      if (!hasMatch) {
        return false;
      }
    }
    if (normalised === "") {
      return true;
    }
    return (
      containsSearchMatchKey(entry.displayName.toLowerCase(), normalised) ||
      containsSearchMatchKey(localizedName(entry).toLowerCase(), normalised) ||
      containsSearchMatchKey(entry.description.toLowerCase(), normalised) ||
      entry.tags.some((tag) =>
        containsSearchMatchKey(tag.toLowerCase(), normalised),
      )
    );
  };

  return [...recommendedEntries, ...otherEntries]
    .filter(matchesSearch)
    .toSorted((left, right) =>
      compareName(localizedName(left), localizedName(right)),
    );
};
