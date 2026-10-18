import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

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
  const normalised = query.trim().toLowerCase();
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
  });
  return [...subset].toSorted((left, right) => {
    if (left.isRecommendedForOrg !== right.isRecommendedForOrg) {
      return left.isRecommendedForOrg ? -1 : 1;
    }
    return compareName(localizedName(left), localizedName(right));
  });
};
