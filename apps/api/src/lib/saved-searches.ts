import type { EntityKind } from "@/api/db/schema-validators";
import type { GlobalSearchResultType } from "@/api/lib/search/types";

export const SAVED_SEARCH_CRITERIA_VERSION = 1 as const;

// Search currently has one execution ordering. Persisting it explicitly makes
// a future ordering additive rather than an ambiguous interpretation of v1.
export const SAVED_SEARCH_SORTS = ["relevance"] as const;
export type SavedSearchSort = (typeof SAVED_SEARCH_SORTS)[number];

export type SavedSearchTimeFilter =
  | { type: "preset"; preset: "day" | "week" | "month" | "year" }
  | {
      type: "custom";
      updatedFrom?: string;
      updatedTo?: string;
    };

/** Versioned, portable subset of the global-search request (no pagination). */
export type SavedSearchCriteria = {
  version: typeof SAVED_SEARCH_CRITERIA_VERSION;
  query: string;
  workspaceIds: string[];
  types: GlobalSearchResultType[];
  kinds: EntityKind[];
  editedByUserIds: string[];
  mimeTypes: string[];
  time?: SavedSearchTimeFilter;
  sort: SavedSearchSort;
};
