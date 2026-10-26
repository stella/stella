import { createSearchQueryMatcher } from "@stll/text-normalize/search-query-matcher";

import type { ToolsCatalogueKind } from "@/features/knowledge/views/tools/tools-catalogue-view";

type SearchableTool = {
  description: string;
  displayName: string;
  isRecommendedForOrg?: boolean | undefined;
  jurisdictions: readonly string[];
  kind: string;
  tags: readonly string[];
};

type FilterToolsCatalogueOptions<T extends SearchableTool> = {
  compareName: (left: string, right: string) => number;
  entries: readonly T[];
  filter: ToolsCatalogueKind;
  jurisdictionFilter: ReadonlySet<string>;
  localizedName: (entry: T) => string;
  query: string;
};

export const filterToolsCatalogueEntries = <T extends SearchableTool>({
  compareName,
  entries,
  filter,
  jurisdictionFilter,
  localizedName,
  query,
}: FilterToolsCatalogueOptions<T>): T[] => {
  const matches = createSearchQueryMatcher(query);
  const subset = entries.filter((entry) => {
    if (filter !== "all" && entry.kind !== filter) {
      return false;
    }
    if (
      jurisdictionFilter.size > 0 &&
      entry.jurisdictions.length > 0 &&
      !entry.jurisdictions.some((code) => jurisdictionFilter.has(code))
    ) {
      return false;
    }
    return (
      matches(entry.displayName) ||
      matches(localizedName(entry)) ||
      matches(entry.description) ||
      entry.tags.some(matches)
    );
  });
  return [...subset].toSorted((left, right) => {
    if (left.isRecommendedForOrg !== right.isRecommendedForOrg) {
      return left.isRecommendedForOrg ? -1 : 1;
    }
    return compareName(localizedName(left), localizedName(right));
  });
};
