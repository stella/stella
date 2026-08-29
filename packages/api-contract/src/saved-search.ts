import type { EntityKind } from "./entity-kinds";
import type { GlobalSearchResultType } from "./search";

export const SAVED_SEARCH_CRITERIA_VERSION = 1 as const;
export const SAVED_SEARCH_SORTS = ["relevance"] as const;

export type SavedSearchSort = (typeof SAVED_SEARCH_SORTS)[number];

export type SavedSearchTimeFilter =
  | { type: "preset"; preset: "day" | "week" | "month" | "year" }
  | {
      type: "custom";
      updatedFrom?: string;
      updatedTo?: string;
    };

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
