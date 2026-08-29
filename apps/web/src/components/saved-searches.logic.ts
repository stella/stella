import {
  resolveUpdatedFrom,
  resolveUpdatedTo,
} from "@/components/search-filters.logic";
import type {
  SearchFilters,
  TimeFilter,
} from "@/components/search-filters.logic";
import type { SavedSearchCriteria } from "@/lib/api-contract";
import { hasSearchQueryOrSelectiveFilter } from "@/lib/search";

type SavedSearchTime = NonNullable<SavedSearchCriteria["time"]>;

export type { SavedSearchCriteria };

type SavedSearchOwner = {
  organizationId: string;
  userId: string;
};

export const savedSearchKeys = {
  all: ["saved-searches"] as const,
  list: ({ organizationId, userId }: SavedSearchOwner) =>
    ["saved-searches", { organizationId, userId }] as const,
};

export const canSaveSearch = ({
  filters,
  query,
}: {
  filters: SearchFilters;
  query: string;
}): boolean =>
  hasSearchQueryOrSelectiveFilter({
    query,
    types: filters.types,
    kinds: filters.kinds,
    editedByUserIds: filters.editedByUserIds,
    mimeTypes: filters.mimeTypes,
    updatedFrom: resolveUpdatedFrom(filters.time),
    updatedTo: resolveUpdatedTo(filters.time),
  });

type SavedSearchListState = {
  itemCount: number;
  status: "error" | "pending" | "success";
};

export const shouldShowSavedSearchList = ({
  itemCount,
  status,
}: SavedSearchListState): boolean => status !== "success" || itemCount > 0;

const toSavedSearchTime = (time: TimeFilter): SavedSearchTime => {
  if (time.mode === "preset") {
    return { type: "preset", preset: time.preset };
  }

  return {
    type: "custom",
    ...(time.updatedFrom !== undefined && { updatedFrom: time.updatedFrom }),
    ...(time.updatedTo !== undefined && { updatedTo: time.updatedTo }),
  };
};

const toSearchTime = (time: SavedSearchTime): TimeFilter => {
  if (time.type === "preset") {
    return { mode: "preset", preset: time.preset };
  }

  return {
    mode: "custom",
    ...(time.updatedFrom !== undefined && { updatedFrom: time.updatedFrom }),
    ...(time.updatedTo !== undefined && { updatedTo: time.updatedTo }),
  };
};

export const toSavedSearchCriteria = ({
  filters,
  query,
}: {
  filters: SearchFilters;
  query: string;
}): SavedSearchCriteria => ({
  version: 1,
  query: query.trim(),
  workspaceIds: [...filters.workspaceIds],
  types: [...filters.types],
  kinds: [...filters.kinds],
  editedByUserIds: [...filters.editedByUserIds],
  mimeTypes: [...filters.mimeTypes],
  ...(filters.time !== undefined && { time: toSavedSearchTime(filters.time) }),
  sort: "relevance",
});

export const toSearchFilters = (
  criteria: SavedSearchCriteria,
): SearchFilters => ({
  workspaceIds: [...criteria.workspaceIds],
  types: criteria.types.length > 0 ? [...criteria.types] : [...criteria.kinds],
  kinds: [],
  editedByUserIds: [...criteria.editedByUserIds],
  mimeTypes: [...criteria.mimeTypes],
  ...(criteria.time !== undefined && { time: toSearchTime(criteria.time) }),
});
